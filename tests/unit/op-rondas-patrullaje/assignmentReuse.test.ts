/**
 * Unit tests — starting a patrol must NOT reuse a stale/old tour assignment.
 *
 * Bug class (already fixed in prod — these PIN the correct behavior so a
 * regression fails loudly): a guard starting a fresh round on a tour that
 * already has a COMPLETED assignment from an earlier round must bind the new
 * scans to the fresh 'assigned' assignment, never re-open or re-count against
 * the old completed one. recordTagScan resolves the active assignment with
 * `status: 'assigned'` precisely so a completed round is invisible to it.
 *
 * These exercise the REAL SiteTourService.recordTagScan() against an in-memory
 * fake db. They complement tests/unit/patrols-rondas/recordTagScan.test.ts
 * (which covers tenant scope / geofence / compliance / completion) by focusing
 * ONLY on the assignment-selection invariant.
 *
 * Run:
 *   cross-env NODE_ENV=test TS_NODE_PROJECT=tsconfig.test.json \
 *     npx mocha -r ts-node/register \
 *     'tests/unit/op-rondas-patrullaje/assignmentReuse.test.ts' --exit --timeout 20000
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

function buildDb(seed: { tags?: any[]; assignments?: any[]; tours?: any[] } = {}) {
  const db: any = {
    siteTourTags: (seed.tags || []).map(makeRow),
    tourAssignments: (seed.assignments || []).map(makeRow),
    tagScans: [] as any[],
    siteTours: (seed.tours || []).map(makeRow),
  };
  const matches = (row: any, where: any) => Object.keys(where).every((k) => row[k] === where[k]);

  db.siteTourTag = {
    async findOne({ where }: any) { return db.siteTourTags.find((r: any) => matches(r, where)) || null; },
    async count({ where }: any) { return db.siteTourTags.filter((r: any) => matches(r, where)).length; },
  };
  db.tourAssignment = {
    __findOneCalls: [] as any[],
    async findOne({ where }: any) {
      db.tourAssignment.__findOneCalls.push(where);
      return db.tourAssignments.find((r: any) => matches(r, where)) || null;
    },
  };
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
  db.guardShift = { async findOne() { return null; } };
  db.sequelize = { async transaction() { return { async commit() {}, async rollback() {} }; } };
  return db;
}

function svc(db: any, tenant = TENANT, guard = 'user-1') {
  return new SiteTourService({
    database: db,
    currentTenant: tenant ? { id: tenant } : null,
    currentUser: guard ? { id: guard } : null,
  } as any);
}

describe('op-rondas · patrol start does not reuse a stale assignment', () => {
  afterEach(() => sinon.restore());

  it('binds a new scan to the FRESH assigned round, ignoring an old COMPLETED one on the same tour', async () => {
    const db = buildDb({
      tags: [
        { id: 'tag-1', tagIdentifier: 'QR1', tenantId: TENANT, siteTourId: 'tour-1', latitude: 0, longitude: 0 },
        { id: 'tag-2', tagIdentifier: 'QR2', tenantId: TENANT, siteTourId: 'tour-1', latitude: 0, longitude: 0 },
      ],
      assignments: [
        // Yesterday's round — already completed. Must NOT be selected.
        { id: 'asg-old', siteTourId: 'tour-1', status: 'completed', tenantId: TENANT, endAt: new Date('2026-07-19T06:00:00Z') },
        // Today's fresh round — this is the active one.
        { id: 'asg-new', siteTourId: 'tour-1', status: 'assigned', tenantId: TENANT, endAt: null },
      ],
      tours: [{ id: 'tour-1', postSiteId: null, name: 'Ronda Norte' }],
    });

    const res = await svc(db).recordTagScan({
      tagIdentifier: 'QR1', securityGuardId: 'sg-9', latitude: 0, longitude: 0, scannedData: {}, stationId: null,
    });

    // The resolution query filtered by status:'assigned' → the completed round is invisible.
    const where = db.tourAssignment.__findOneCalls[0];
    assert.strictEqual(where.status, 'assigned', 'active-assignment lookup must exclude completed rounds');

    assert.strictEqual(res.assignment.id, 'asg-new', 'scan binds to the fresh round');
    assert.strictEqual(db.tagScans[0].tourAssignmentId, 'asg-new');
    // The old completed assignment is untouched (no re-open, no endAt change).
    const oldAsg = db.tourAssignments.find((a: any) => a.id === 'asg-old');
    assert.strictEqual(oldAsg.status, 'completed', 'the old round stays completed');
  });

  it('does NOT re-open a completed round when it is the ONLY assignment (scan binds to null, not the old round)', async () => {
    const db = buildDb({
      tags: [{ id: 'tag-1', tagIdentifier: 'QR1', tenantId: TENANT, siteTourId: 'tour-1', latitude: 0, longitude: 0 }],
      assignments: [
        { id: 'asg-old', siteTourId: 'tour-1', status: 'completed', tenantId: TENANT, endAt: new Date('2026-07-19T06:00:00Z') },
      ],
      tours: [{ id: 'tour-1', postSiteId: null, name: 'Ronda Norte' }],
    });

    const res = await svc(db).recordTagScan({
      tagIdentifier: 'QR1', securityGuardId: 'sg-9', latitude: 0, longitude: 0, scannedData: {}, stationId: null,
    });

    // No 'assigned' round exists → resolution yields null; the scan is recorded
    // but NOT attributed to the old completed round.
    assert.strictEqual(res.assignment, null, 'no active round to bind to');
    assert.strictEqual(db.tagScans.length, 1);
    assert.strictEqual(db.tagScans[0].tourAssignmentId, null, 'scan not counted against the old completed round');
    const oldAsg = db.tourAssignments[0];
    assert.strictEqual(oldAsg.status, 'completed', 'old round unchanged — not re-opened');
    assert.strictEqual(oldAsg.endAt.toISOString(), '2026-07-19T06:00:00.000Z', 'endAt not overwritten');
  });

  it('a completed round is not re-completed / re-notified by a later stray scan', async () => {
    // Only a completed assignment exists; a stray scan comes in. Because the
    // scan binds to null, the completion branch (which requires an assignment
    // whose status !== completed) never runs → no duplicate completion notify.
    const rondaNotify = require('../../../src/services/rondaNotify');
    const notifyStub = sinon.stub(rondaNotify, 'notifyPatrol').resolves();
    const db = buildDb({
      tags: [{ id: 'tag-1', tagIdentifier: 'QR1', tenantId: TENANT, siteTourId: 'tour-1', latitude: 0, longitude: 0 }],
      assignments: [{ id: 'asg-old', siteTourId: 'tour-1', status: 'completed', tenantId: TENANT }],
      tours: [{ id: 'tour-1', postSiteId: null, name: 'Ronda Norte' }],
    });

    await svc(db).recordTagScan({
      tagIdentifier: 'QR1', securityGuardId: 'sg-9', latitude: 0, longitude: 0, scannedData: {}, stationId: null,
    });

    assert.ok(notifyStub.notCalled, 'a stray scan on a completed tour must not fire a completion notify');
  });
});
