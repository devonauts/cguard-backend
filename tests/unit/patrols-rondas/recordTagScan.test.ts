/**
 * Unit tests — Patrols / Rondas (siteTour + tagScan + rondaSettings).
 *
 * These tests exercise the REAL SiteTourService.recordTagScan() and the REAL
 * resolveRondaSettings()/haversineDistance() helpers against an in-memory fake
 * `db` (no MySQL, no network). sinon is used only to neutralise the best-effort
 * post-commit notify path, so the core scan logic is fully under test:
 *
 *   1.  Tenant context is REQUIRED (no tenant → 400, nothing written).
 *   2.  Tag resolution is scoped by tenantId (cross-tenant collision → 404,
 *       a foreign tenant's tour is never stamped — the IDOR fix).
 *   3.  A scan records against the guard's ACTIVE assignment for that tour.
 *   4.  Idempotency: re-scanning the same tag for the same assignment does NOT
 *       create a second tagScan row (returns the existing one).
 *   5.  Server-side geofence: in-radius → validLocation true; out-of-radius →
 *       false; the checkpoint's own geofenceRadius wins over the ronda default.
 *   6.  rondaSettings radius is used when the checkpoint has none.
 *   7.  Compliance: requirePhoto / requireNote / requireGeofence are enforced
 *       server-side and stamped onto scannedData.compliance.
 *   8.  Completion: scanning the LAST checkpoint flips the assignment to
 *       'completed' and stamps endAt (drives the CRM completion notification).
 *   9.  resolveRondaSettings precedence: per-post override → tenant default →
 *       built-in defaults.
 *   10. haversineDistance sanity (distance math the geofence relies on).
 *
 * Run:
 *   cd backend && cross-env NODE_ENV=test TS_NODE_PROJECT=tsconfig.test.json \
 *     npx mocha -r ts-node/register \
 *     'tests/unit/patrols-rondas/recordTagScan.test.ts' --exit --timeout 20000
 */

import assert from 'assert';
import sinon from 'sinon';

import SiteTourService from '../../../src/services/siteTourService';
import { resolveRondaSettings, RONDA_DEFAULT_SETTINGS } from '../../../src/services/rondaNotify';
import { haversineDistance } from '../../../src/lib/geofence';

const TENANT_A = 'tenant-A';
const TENANT_B = 'tenant-B';

// ──────────────────────────── In-memory fake DB ─────────────────────────────
//
// A tiny Sequelize-shaped stub. Each "model" supports just the calls
// recordTagScan / resolveRondaSettings make. Rows live in plain arrays so we can
// assert on persisted tagScans + assignment mutations.

function makeRow(data: any) {
  return {
    ...data,
    get(opts?: any) {
      if (opts && opts.plain) return { ...data };
      return data;
    },
    async update(patch: any) {
      Object.assign(data, patch);
      Object.assign(this, patch);
      return this;
    },
  };
}

interface FakeDb {
  siteTourTags: any[];
  tourAssignments: any[];
  tagScans: any[];
  siteTours: any[];
  stations: any[];
  rondaSettingsRows: any[];
  securityGuards: any[];
  [key: string]: any;
}

function buildDb(seed: {
  tags?: any[];
  assignments?: any[];
  tours?: any[];
  stations?: any[];
  rondaSettings?: any[];
} = {}): FakeDb {
  const db: FakeDb = {
    siteTourTags: (seed.tags || []).map(makeRow),
    tourAssignments: (seed.assignments || []).map(makeRow),
    tagScans: [],
    siteTours: (seed.tours || []).map(makeRow),
    stations: (seed.stations || []).map(makeRow),
    rondaSettingsRows: (seed.rondaSettings || []).map(makeRow),
    securityGuards: [],
  };

  const matches = (row: any, where: any) =>
    Object.keys(where).every((k) => {
      // treat `undefined`/absent the same; null must match null explicitly
      return row[k] === where[k];
    });

  db.siteTourTag = {
    async findOne({ where }: any) {
      return db.siteTourTags.find((r) => matches(r, where)) || null;
    },
    async count({ where }: any) {
      return db.siteTourTags.filter((r) => matches(r, where)).length;
    },
  };

  db.tourAssignment = {
    async findOne({ where }: any) {
      return db.tourAssignments.find((r) => matches(r, where)) || null;
    },
  };

  db.tagScan = {
    async findOne({ where }: any) {
      return db.tagScans.find((r) => matches(r, where)) || null;
    },
    async create(data: any) {
      const row = makeRow({ id: `scan-${db.tagScans.length + 1}`, ...data });
      db.tagScans.push(row);
      return row;
    },
    async count({ where, distinct, col }: any) {
      const rows = db.tagScans.filter((r) => matches(r, where));
      if (distinct && col) {
        return new Set(rows.map((r) => r[col])).size;
      }
      return rows.length;
    },
  };

  db.siteTour = {
    async findByPk(id: string) {
      return db.siteTours.find((r) => r.id === id) || null;
    },
  };

  db.station = {
    async findByPk(id: string) {
      return db.stations.find((r) => r.id === id) || null;
    },
  };

  db.rondaSettings = {
    async findOne({ where }: any) {
      return db.rondaSettingsRows.find((r) => matches(r, where)) || null;
    },
  };

  db.securityGuard = {
    async findByPk(id: string) {
      return db.securityGuards.find((r) => r.id === id) || null;
    },
  };

  // SequelizeRepository.createTransaction → db.sequelize.transaction()
  db.sequelize = {
    async transaction() {
      return {
        async commit() { /* no-op */ },
        async rollback() { /* no-op */ },
      };
    },
  };

  return db;
}

function svc(db: any, tenant: string | null, guard: string | null = 'user-1') {
  return new SiteTourService({
    database: db,
    currentTenant: tenant ? { id: tenant } : null,
    currentUser: guard ? { id: guard } : null,
  } as any);
}

// ─────────────────────────────────── Tests ──────────────────────────────────

describe('Rondas — recordTagScan core logic', () => {
  afterEach(() => sinon.restore());

  // 1 ── Tenant context required ─────────────────────────────────────────────
  it('rejects a scan with no tenant context (400) and writes nothing', async () => {
    const db = buildDb({ tags: [{ id: 'tag-1', tagIdentifier: 'QR1', tenantId: TENANT_A, siteTourId: 'tour-1' }] });
    let code: number | undefined;
    try {
      await svc(db, null).recordTagScan({
        tagIdentifier: 'QR1', securityGuardId: 'sg-1', latitude: 0, longitude: 0, scannedData: {}, stationId: null,
      });
      assert.fail('should have thrown');
    } catch (e: any) {
      code = e.code;
    }
    assert.strictEqual(code, 400);
    assert.strictEqual(db.tagScans.length, 0);
  });

  // 2 ── Tag lookup is tenant-scoped (cross-tenant IDOR fix) ──────────────────
  it('does NOT resolve another tenant\'s tag for a colliding identifier (404)', async () => {
    // Same tagIdentifier "DUP" exists for tenant B only. Tenant A scanning it
    // must NOT find/stamp B's tag.
    const db = buildDb({
      tags: [{ id: 'tag-b', tagIdentifier: 'DUP', tenantId: TENANT_B, siteTourId: 'tour-b' }],
    });
    let code: number | undefined;
    try {
      await svc(db, TENANT_A).recordTagScan({
        tagIdentifier: 'DUP', securityGuardId: 'sg-1', latitude: 0, longitude: 0, scannedData: {}, stationId: null,
      });
      assert.fail('should have thrown 404');
    } catch (e: any) {
      code = e.code;
    }
    assert.strictEqual(code, 404, 'a foreign tenant tag must be invisible');
    assert.strictEqual(db.tagScans.length, 0);
  });

  // 3 ── Records against the active assignment for that tour ──────────────────
  it('records the scan against the guard\'s active assignment for the tour', async () => {
    const db = buildDb({
      tags: [
        { id: 'tag-1', tagIdentifier: 'QR1', tenantId: TENANT_A, siteTourId: 'tour-1', latitude: 0, longitude: 0, postSiteId: 'ps-1' },
        { id: 'tag-2', tagIdentifier: 'QR2', tenantId: TENANT_A, siteTourId: 'tour-1', latitude: 0, longitude: 0, postSiteId: 'ps-1' },
      ],
      assignments: [{ id: 'asg-1', siteTourId: 'tour-1', status: 'assigned', tenantId: TENANT_A }],
      tours: [{ id: 'tour-1', postSiteId: 'ps-1', name: 'Ronda Norte' }],
    });

    const res = await svc(db, TENANT_A).recordTagScan({
      tagIdentifier: 'QR1', securityGuardId: 'sg-9', latitude: 0, longitude: 0, scannedData: {}, stationId: null,
    });

    assert.strictEqual(db.tagScans.length, 1);
    assert.strictEqual(db.tagScans[0].tourAssignmentId, 'asg-1', 'scan binds to the active assignment');
    assert.strictEqual(db.tagScans[0].siteTourTagId, 'tag-1');
    assert.strictEqual(db.tagScans[0].securityGuardId, 'sg-9');
    assert.strictEqual(res.assignment.id, 'asg-1');
    // Tour NOT complete yet (2 tags, 1 scanned) → assignment stays 'assigned'.
    assert.strictEqual(db.tourAssignments[0].status, 'assigned');
  });

  // 4 ── Idempotency per (assignment, tag) ───────────────────────────────────
  it('is idempotent — a repeat scan of the same tag does not create a 2nd row', async () => {
    const db = buildDb({
      tags: [
        { id: 'tag-1', tagIdentifier: 'QR1', tenantId: TENANT_A, siteTourId: 'tour-1', latitude: 0, longitude: 0 },
        { id: 'tag-2', tagIdentifier: 'QR2', tenantId: TENANT_A, siteTourId: 'tour-1', latitude: 0, longitude: 0 },
      ],
      assignments: [{ id: 'asg-1', siteTourId: 'tour-1', status: 'assigned', tenantId: TENANT_A }],
      tours: [{ id: 'tour-1', postSiteId: null, name: 'R' }],
    });
    const service = svc(db, TENANT_A);

    await service.recordTagScan({ tagIdentifier: 'QR1', securityGuardId: 'sg-1', latitude: 0, longitude: 0, scannedData: {}, stationId: null });
    const second = await service.recordTagScan({ tagIdentifier: 'QR1', securityGuardId: 'sg-1', latitude: 0, longitude: 0, scannedData: {}, stationId: null });

    assert.strictEqual(db.tagScans.length, 1, 'still only one scan row');
    assert.strictEqual(second.scan.id, db.tagScans[0].id, 'returns the existing scan');
  });

  // 5 ── Geofence: in/out of radius + checkpoint radius wins ──────────────────
  it('marks validLocation=true when the guard is inside the checkpoint radius', async () => {
    const db = buildDb({
      tags: [{ id: 'tag-1', tagIdentifier: 'QR1', tenantId: TENANT_A, siteTourId: 'tour-1', latitude: -0.18, longitude: -78.47, geofenceRadius: 75 }],
      tours: [{ id: 'tour-1', postSiteId: null, name: 'R' }],
    });
    const res = await svc(db, TENANT_A).recordTagScan({
      // ~same point → distance ≈ 0
      tagIdentifier: 'QR1', securityGuardId: 'sg-1', latitude: -0.18, longitude: -78.47, scannedData: {}, stationId: null,
    });
    assert.strictEqual(res.location!.validLocation, true);
    assert.ok(res.location!.distanceMeters! <= 75);
    assert.strictEqual(res.location!.radiusM, 75, 'checkpoint geofenceRadius is used');
  });

  it('marks validLocation=false when the guard is outside the checkpoint radius', async () => {
    const db = buildDb({
      tags: [{ id: 'tag-1', tagIdentifier: 'QR1', tenantId: TENANT_A, siteTourId: 'tour-1', latitude: -0.18, longitude: -78.47, geofenceRadius: 50 }],
      tours: [{ id: 'tour-1', postSiteId: null, name: 'R' }],
    });
    const res = await svc(db, TENANT_A).recordTagScan({
      // ~1.1km north (0.01 deg lat ≈ 1111m) → well outside 50m
      tagIdentifier: 'QR1', securityGuardId: 'sg-1', latitude: -0.17, longitude: -78.47, scannedData: {}, stationId: null,
    });
    assert.strictEqual(res.location!.validLocation, false);
    assert.ok(res.location!.distanceMeters! > 50);
  });

  // 6 ── rondaSettings radius used when the checkpoint defines none ───────────
  it('falls back to the configured rondaSettings.geofenceRadius when the tag has none', async () => {
    const db = buildDb({
      tags: [{ id: 'tag-1', tagIdentifier: 'QR1', tenantId: TENANT_A, siteTourId: 'tour-1', latitude: -0.18, longitude: -78.47, geofenceRadius: null, postSiteId: 'ps-1' }],
      tours: [{ id: 'tour-1', postSiteId: 'ps-1', name: 'R' }],
      rondaSettings: [{ tenantId: TENANT_A, postSiteId: 'ps-1', geofenceRadius: 200, requirePhoto: false, requireNote: false, requireGeofence: false }],
    });
    const res = await svc(db, TENANT_A).recordTagScan({
      // ~166m away → outside default(75) but inside the configured 200m
      tagIdentifier: 'QR1', securityGuardId: 'sg-1', latitude: -0.1785, longitude: -78.47, scannedData: {}, stationId: null,
    });
    assert.strictEqual(res.location!.radiusM, 200, 'ronda settings radius is applied');
    assert.strictEqual(res.location!.validLocation, true);
  });

  // 7 ── Compliance enforced + stamped server-side ───────────────────────────
  it('records compliance: requirePhoto/requireNote unmet → compliant=false', async () => {
    const db = buildDb({
      tags: [{ id: 'tag-1', tagIdentifier: 'QR1', tenantId: TENANT_A, siteTourId: 'tour-1', latitude: 0, longitude: 0, postSiteId: 'ps-1' }],
      tours: [{ id: 'tour-1', postSiteId: 'ps-1', name: 'R' }],
      rondaSettings: [{ tenantId: TENANT_A, postSiteId: 'ps-1', requirePhoto: true, requireNote: true, requireGeofence: false, geofenceRadius: 50 }],
    });
    const res = await svc(db, TENANT_A).recordTagScan({
      tagIdentifier: 'QR1', securityGuardId: 'sg-1', latitude: 0, longitude: 0, scannedData: { notes: '' }, stationId: null,
    });
    assert.strictEqual(res.compliance.requirePhoto, true);
    assert.strictEqual(res.compliance.photoProvided, false);
    assert.strictEqual(res.compliance.requireNote, true);
    assert.strictEqual(res.compliance.noteProvided, false);
    assert.strictEqual(res.compliance.compliant, false);
    // Stamped onto the persisted scannedData for audit.
    assert.strictEqual(db.tagScans[0].scannedData.compliance.compliant, false);
  });

  it('records compliance=true when photo + note are provided and geofence ok', async () => {
    const db = buildDb({
      tags: [{ id: 'tag-1', tagIdentifier: 'QR1', tenantId: TENANT_A, siteTourId: 'tour-1', latitude: -0.18, longitude: -78.47, geofenceRadius: 75, postSiteId: 'ps-1' }],
      tours: [{ id: 'tour-1', postSiteId: 'ps-1', name: 'R' }],
      rondaSettings: [{ tenantId: TENANT_A, postSiteId: 'ps-1', requirePhoto: true, requireNote: true, requireGeofence: true }],
    });
    const res = await svc(db, TENANT_A).recordTagScan({
      tagIdentifier: 'QR1', securityGuardId: 'sg-1', latitude: -0.18, longitude: -78.47,
      scannedData: { photoPrivateUrl: 'https://x/p.jpg', notes: 'todo en orden' }, stationId: null,
    });
    assert.strictEqual(res.compliance.photoProvided, true);
    assert.strictEqual(res.compliance.noteProvided, true);
    assert.strictEqual(res.compliance.locationValid, true);
    assert.strictEqual(res.compliance.compliant, true);
  });

  // 8 ── Completion flips the assignment to 'completed' ──────────────────────
  it('marks the assignment completed when the last checkpoint is scanned', async () => {
    // Single-checkpoint tour → first scan completes it.
    const db = buildDb({
      tags: [{ id: 'tag-1', tagIdentifier: 'QR1', tenantId: TENANT_A, siteTourId: 'tour-1', latitude: 0, longitude: 0, postSiteId: 'ps-1' }],
      assignments: [{ id: 'asg-1', siteTourId: 'tour-1', status: 'assigned', tenantId: TENANT_A }],
      tours: [{ id: 'tour-1', postSiteId: 'ps-1', name: 'Ronda Única' }],
    });
    // Neutralise the best-effort post-commit notify (it require()s pushService etc.)
    const rondaNotify = require('../../../src/services/rondaNotify');
    const notifyStub = sinon.stub(rondaNotify, 'notifyPatrol').resolves();

    const res = await svc(db, TENANT_A).recordTagScan({
      tagIdentifier: 'QR1', securityGuardId: 'sg-1', latitude: 0, longitude: 0, scannedData: {}, stationId: null,
    });

    assert.strictEqual(db.tourAssignments[0].status, 'completed', 'assignment completes');
    assert.ok(db.tourAssignments[0].endAt instanceof Date, 'endAt stamped');
    assert.strictEqual(res.assignment.status, 'completed');
    // Completion notify (CRM + client) was invoked exactly once.
    assert.ok(notifyStub.calledOnce, 'notifyPatrol fired on completion');
    const arg = notifyStub.firstCall.args[1];
    assert.strictEqual(arg.event, 'complete');
    assert.strictEqual(arg.tenantId, TENANT_A);
  });

  it('does NOT complete (or notify) when checkpoints remain unscanned', async () => {
    const db = buildDb({
      tags: [
        { id: 'tag-1', tagIdentifier: 'QR1', tenantId: TENANT_A, siteTourId: 'tour-1', latitude: 0, longitude: 0 },
        { id: 'tag-2', tagIdentifier: 'QR2', tenantId: TENANT_A, siteTourId: 'tour-1', latitude: 0, longitude: 0 },
      ],
      assignments: [{ id: 'asg-1', siteTourId: 'tour-1', status: 'assigned', tenantId: TENANT_A }],
      tours: [{ id: 'tour-1', postSiteId: null, name: 'R' }],
    });
    const rondaNotify = require('../../../src/services/rondaNotify');
    const notifyStub = sinon.stub(rondaNotify, 'notifyPatrol').resolves();

    await svc(db, TENANT_A).recordTagScan({
      tagIdentifier: 'QR1', securityGuardId: 'sg-1', latitude: 0, longitude: 0, scannedData: {}, stationId: null,
    });

    assert.strictEqual(db.tourAssignments[0].status, 'assigned');
    assert.ok(notifyStub.notCalled, 'no completion notify mid-patrol');
  });
});

// ───────────────────── resolveRondaSettings precedence ───────────────────────

describe('Rondas — resolveRondaSettings precedence', () => {
  function settingsDb(rows: any[]) {
    return {
      rondaSettings: {
        async findOne({ where }: any) {
          const r = rows.find((x) =>
            x.tenantId === where.tenantId &&
            (where.postSiteId === undefined || x.postSiteId === where.postSiteId),
          );
          return r ? makeRow(r) : null;
        },
      },
    };
  }

  it('uses the per-post override when present', async () => {
    const db = settingsDb([
      { tenantId: TENANT_A, postSiteId: null, geofenceRadius: 100 },
      { tenantId: TENANT_A, postSiteId: 'ps-1', geofenceRadius: 25 },
    ]);
    const eff = await resolveRondaSettings(db, TENANT_A, 'ps-1');
    assert.strictEqual(eff.geofenceRadius, 25, 'post override wins');
  });

  it('falls back to the tenant default (postSiteId=null) when no per-post row', async () => {
    const db = settingsDb([{ tenantId: TENANT_A, postSiteId: null, geofenceRadius: 100 }]);
    const eff = await resolveRondaSettings(db, TENANT_A, 'ps-unknown');
    assert.strictEqual(eff.geofenceRadius, 100, 'tenant default used');
  });

  it('falls back to built-in defaults when the tenant has no rows at all', async () => {
    const db = settingsDb([]);
    const eff = await resolveRondaSettings(db, TENANT_A, 'ps-1');
    assert.strictEqual(eff.geofenceRadius, RONDA_DEFAULT_SETTINGS.geofenceRadius);
    assert.strictEqual(eff.requirePhoto, RONDA_DEFAULT_SETTINGS.requirePhoto);
  });
});

// ──────────────────────────── Haversine sanity ───────────────────────────────

describe('Rondas — haversineDistance (geofence math)', () => {
  it('returns ~0 for identical coordinates', () => {
    assert.ok(haversineDistance(-0.18, -78.47, -0.18, -78.47) < 0.5);
  });

  it('returns ~1111m for 0.01° of latitude', () => {
    const d = haversineDistance(-0.18, -78.47, -0.17, -78.47);
    assert.ok(d > 1050 && d < 1160, `expected ~1111m, got ${Math.round(d)}m`);
  });
});
