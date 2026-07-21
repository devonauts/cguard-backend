/**
 * Unit tests — tag-scan gate: rounds only count while ON DUTY.
 *
 * Post rule `requireActiveShiftForRounds` (Config › Reglas de puesto) must be
 * enforced SERVER-SIDE in recordTagScan, not merely in the worker app — an
 * off-shift guard scanning a QR must be rejected (400) and NO tagScan row is
 * written. When the rule is off (default) or the guard has an open shift, the
 * scan proceeds. This gate is not covered by the existing recordTagScan suite.
 *
 * Run:
 *   cross-env NODE_ENV=test TS_NODE_PROJECT=tsconfig.test.json \
 *     npx mocha -r ts-node/register \
 *     'tests/unit/op-rondas-patrullaje/tagScanGate.test.ts' --exit --timeout 20000
 */

import assert from 'assert';
import sinon from 'sinon';

import SiteTourService from '../../../src/services/siteTourService';

const TENANT = 'tenant-A';

function makeRow(data: any) {
  return {
    ...data,
    get(opts?: any) { return opts && opts.plain ? { ...data } : data; },
    async update(patch: any) { Object.assign(data, patch); Object.assign(this, patch); return this; },
  };
}

function buildDb(seed: {
  tags?: any[]; assignments?: any[]; tours?: any[];
  settings?: any[]; shifts?: any[];
} = {}) {
  const db: any = {
    siteTourTags: (seed.tags || []).map(makeRow),
    tourAssignments: (seed.assignments || []).map(makeRow),
    tagScans: [] as any[],
    siteTours: (seed.tours || []).map(makeRow),
    settingsRows: (seed.settings || []).map(makeRow),
    shifts: (seed.shifts || []).map(makeRow),
  };
  const matches = (row: any, where: any) => Object.keys(where).every((k) => row[k] === where[k]);

  db.siteTourTag = {
    async findOne({ where }: any) { return db.siteTourTags.find((r: any) => matches(r, where)) || null; },
    async count({ where }: any) { return db.siteTourTags.filter((r: any) => matches(r, where)).length; },
  };
  db.tourAssignment = { async findOne({ where }: any) { return db.tourAssignments.find((r: any) => matches(r, where)) || null; } };
  db.tagScan = {
    async findOne({ where }: any) { return db.tagScans.find((r: any) => matches(r, where)) || null; },
    async create(data: any) { const row = makeRow({ id: `scan-${db.tagScans.length + 1}`, ...data }); db.tagScans.push(row); return row; },
    async count({ where, distinct, col }: any) {
      const rows = db.tagScans.filter((r: any) => matches(r, where));
      if (distinct && col) return new Set(rows.map((r: any) => r[col])).size;
      return rows.length;
    },
  };
  db.siteTour = { async findByPk(id: string) { return db.siteTours.find((r: any) => r.id === id) || null; } };
  db.station = { async findByPk() { return null; } };
  db.rondaSettings = { async findOne() { return null; } };
  db.securityGuard = { async findByPk() { return null; } };
  // The postRules source + the on-duty check.
  db.settings = { async findOne({ where }: any) { return db.settingsRows.find((r: any) => r.tenantId === where.tenantId) || null; } };
  db.guardShift = { async findOne({ where }: any) { return db.shifts.find((r: any) => matches(r, where)) || null; } };
  db.sequelize = { async transaction() { return { async commit() {}, async rollback() {} }; } };
  return db;
}

function svc(db: any, tenant = TENANT, guard = 'user-1') {
  return new SiteTourService({
    database: db,
    currentTenant: { id: tenant },
    currentUser: { id: guard },
  } as any);
}

const scanArgs = () => ({ tagIdentifier: 'QR1', securityGuardId: 'sg-1', latitude: 0, longitude: 0, scannedData: {}, stationId: null });

describe('op-rondas · tag-scan gate (requireActiveShiftForRounds)', () => {
  afterEach(() => sinon.restore());

  const baseSeed = (extra: any = {}) => ({
    // Two checkpoints so a single scan does not COMPLETE the round (and thus
    // does not fire the best-effort completion notify) — keeps the gate under test.
    tags: [
      { id: 'tag-1', tagIdentifier: 'QR1', tenantId: TENANT, siteTourId: 'tour-1', latitude: 0, longitude: 0 },
      { id: 'tag-2', tagIdentifier: 'QR2', tenantId: TENANT, siteTourId: 'tour-1', latitude: 0, longitude: 0 },
    ],
    assignments: [{ id: 'asg-1', siteTourId: 'tour-1', status: 'assigned', tenantId: TENANT }],
    tours: [{ id: 'tour-1', postSiteId: null, name: 'R' }],
    ...extra,
  });

  it('rejects (400) an off-shift scan when the rule is ON, and writes NO tagScan', async () => {
    const db = buildDb(baseSeed({
      settings: [{ tenantId: TENANT, postRules: { requireActiveShiftForRounds: true } }],
      shifts: [], // no open shift for this guard
    }));
    let code: number | undefined;
    try {
      await svc(db).recordTagScan(scanArgs());
      assert.fail('should have thrown');
    } catch (e: any) { code = e.code; }
    assert.strictEqual(code, 400, 'off-shift scan is blocked server-side');
    assert.strictEqual(db.tagScans.length, 0, 'nothing recorded');
  });

  it('allows the scan when the rule is ON and the guard HAS an open shift', async () => {
    const db = buildDb(baseSeed({
      settings: [{ tenantId: TENANT, postRules: { requireActiveShiftForRounds: true } }],
      shifts: [{ id: 'sh-1', tenantId: TENANT, guardNameId: 'sg-1', punchOutTime: null }],
    }));
    const res = await svc(db).recordTagScan(scanArgs());
    assert.strictEqual(db.tagScans.length, 1, 'on-duty scan recorded');
    assert.strictEqual(res.scan.securityGuardId, 'sg-1');
  });

  it('allows the scan when the rule is OFF (default), regardless of shift state', async () => {
    const db = buildDb(baseSeed({
      settings: [{ tenantId: TENANT, postRules: { requireActiveShiftForRounds: false } }],
      shifts: [],
    }));
    const res = await svc(db).recordTagScan(scanArgs());
    assert.strictEqual(db.tagScans.length, 1, 'gate off → scan proceeds even off-shift');
    assert.strictEqual(res.tag.id, 'tag-1');
  });
});
