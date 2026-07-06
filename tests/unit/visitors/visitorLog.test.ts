/**
 * Unit tests — visitor control (control de visitas).
 *
 * Exercises the REAL VisitorLogRepository logic against an in-memory fake `db`
 * (no MySQL, no network). The two recently-hardened pieces are under test:
 *
 *   1. ATTRIBUTION — a guard-registered visit with NO station/post must roll up
 *      to station → postSite → client via the server-side fallback cascade
 *      (current shift → active clock-in → permanent station junction →
 *      assigned post site), then complete the chain from whichever link landed.
 *      Without it the visit is orphaned and invisible to the owning client.
 *
 *   2. READ ACL (_buildAssignedVisitorLogAcl) — controls which rows a non-admin
 *      sees on BOTH the CRM staff page and the client-portal customer view
 *      (same Visitors page, role-filtered by the backend):
 *        • admin                → no ACL (sees every tenant row)
 *        • guard (creator)      → can ALWAYS see rows they createdById, even
 *                                 outside their assigned post/station scope
 *        • guard (post/station) → rows for assigned posts/stations
 *        • customer (client)    → rows for posts owned by their clientAccountId
 *
 * Only AuditLog / FileRepository side-effects are stubbed with sinon, so the
 * actual attribution cascade, denormalization and ACL clause construction are
 * all real.
 *
 * Run:
 *   cross-env NODE_ENV=test TS_NODE_PROJECT=tsconfig.test.json \
 *     npx mocha -r ts-node/register \
 *     'tests/unit/visitors/visitorLog.test.ts' --exit --timeout 20000
 */

import assert from 'assert';
import sinon from 'sinon';
import Sequelize from 'sequelize';

import VisitorLogRepository from '../../../src/database/repositories/visitorLogRepository';
import AuditLogRepository from '../../../src/database/repositories/auditLogRepository';
import FileRepository from '../../../src/database/repositories/fileRepository';
import Roles from '../../../src/security/roles';

const Op = Sequelize.Op;

const TENANT = 'tenant-A';

// ───────────────────────────── fake row helper ───────────────────────────────
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
    async destroy() {
      data._destroyed = true;
    },
  };
}

/**
 * Build a fake Sequelize-shaped db. Seeds only the models the repository
 * touches. `seed` lets each test inject the specific rows it needs.
 */
function buildDb(seed: {
  shifts?: any[];
  securityGuards?: any[];
  guardShifts?: any[];
  stations?: any[];
  tenantUsers?: any[];
  businessInfos?: any[];
  clientAccounts?: any[];
  visitorLogs?: any[];
} = {}) {
  // Default tenantId=TENANT on every seed row so they match the (correct)
  // tenant-scoped by-id lookups the repo now uses (cross-tenant-leak fix a890854).
  const t = (r: any) => makeRow({ tenantId: TENANT, ...r });
  const state = {
    shifts: (seed.shifts || []).map(t),
    securityGuards: (seed.securityGuards || []).map(t),
    guardShifts: (seed.guardShifts || []).map(t),
    stations: (seed.stations || []).map(t),
    tenantUsers: (seed.tenantUsers || []).map(t),
    businessInfos: (seed.businessInfos || []).map(t),
    clientAccounts: (seed.clientAccounts || []).map(t),
    visitorLogs: (seed.visitorLogs || []).map(t),
  };

  const matchesWhere = (row: any, where: any): boolean => {
    if (!where) return true;
    for (const key of Object.keys(where)) {
      if (key === (Op.and as any) || key === (Op.or as any)) continue;
      const cond = where[key];
      const val = row[key];
      if (cond && typeof cond === 'object') {
        if (Op.lte in cond && !(val <= cond[Op.lte])) return false;
        if (Op.gte in cond && !(val >= cond[Op.gte])) return false;
        if (Op.ne in cond && !(val !== cond[Op.ne])) return false;
        if (Op.in in cond && !cond[Op.in].includes(val)) return false;
      } else if (cond === null) {
        if (val !== null && val !== undefined) return false;
      } else {
        if (String(val) !== String(cond)) return false;
      }
    }
    return true;
  };

  const db: any = {
    Sequelize,
    sequelize: {
      async transaction() {
        return { commit: async () => {}, rollback: async () => {} };
      },
    },

    shift: {
      async findOne({ where }: any) {
        return state.shifts.find((r) => matchesWhere(r, where)) || null;
      },
    },

    securityGuard: {
      async findOne({ where }: any) {
        return state.securityGuards.find((r) => matchesWhere(r, where)) || null;
      },
    },

    guardShift: {
      async findOne({ where }: any) {
        return state.guardShifts.find((r) => matchesWhere(r, where)) || null;
      },
    },

    // station.findOne with an `assignedGuards` include filters by the junction
    // (we model the junction inline on each station row as `_guardIds`).
    station: {
      async findOne({ where, include }: any) {
        const inc = include && include[0];
        const guardId = inc && inc.where && inc.where.id;
        return (
          state.stations.find(
            (r) =>
              matchesWhere(r, where) &&
              (!guardId || (r._guardIds || []).includes(guardId)),
          ) || null
        );
      },
      async findAll({ where, include }: any) {
        const inc = include && include[0];
        const guardId = inc && inc.where && inc.where.id;
        return state.stations.filter(
          (r) =>
            matchesWhere(r, where) &&
            (!guardId || (r._guardIds || []).includes(guardId)),
        );
      },
      async findByPk(id: string) {
        return state.stations.find((r) => String(r.id) === String(id)) || null;
      },
    },

    tenantUser: {
      async findOne({ where }: any) {
        return state.tenantUsers.find((r) => matchesWhere(r, where)) || null;
      },
    },

    businessInfo: {
      async findByPk(id: string) {
        return state.businessInfos.find((r) => String(r.id) === String(id)) || null;
      },
      // Tenant-scoped by-id lookup used by the postSite → client completion.
      async findOne({ where }: any) {
        return state.businessInfos.find((r) => matchesWhere(r, where)) || null;
      },
      async findAll({ where }: any) {
        return state.businessInfos.filter((r) => matchesWhere(r, where));
      },
    },

    clientAccount: {
      async findByPk(id: string) {
        return state.clientAccounts.find((r) => String(r.id) === String(id)) || null;
      },
      async findOne({ where }: any) {
        return state.clientAccounts.find((r) => matchesWhere(r, where)) || null;
      },
    },

    // no station_id column on the junction by default → ACL skips that branch.
    tenant_user_post_sites: {
      rawAttributes: {},
      async findAll() {
        return [];
      },
    },

    file: {
      async findAll() {
        return [];
      },
    },

    visitorLog: {
      async create(data: any) {
        const row = makeRow({ id: `vl-${state.visitorLogs.length + 1}`, ...data });
        state.visitorLogs.push(row);
        return row;
      },
      async findOne({ where }: any) {
        // Flatten an {[Op.and]: [...]} where into a predicate set.
        const clauses: any[] = where[Op.and] ? where[Op.and] : [where];
        return (
          state.visitorLogs.find((r) =>
            clauses.every((c) => matchesAclClause(r, c)),
          ) || null
        );
      },
      async findAndCountAll({ where }: any) {
        const clauses: any[] = where[Op.and] ? where[Op.and] : [where];
        const rows = state.visitorLogs.filter((r) =>
          clauses.every((c) => matchesAclClause(r, c)),
        );
        return { rows, count: rows.length };
      },
    },

    _state: state,
  };

  // matchesAclClause understands the Op.or shape the ACL produces.
  function matchesAclClause(row: any, clause: any): boolean {
    if (clause[Op.or]) {
      return clause[Op.or].some((sub: any) => matchesAclClause(row, sub));
    }
    return matchesWhere(row, clause);
  }

  return db;
}

/** Options builder mirroring IRepositoryOptions used in the API path. */
function makeOptions(db: any, currentUser: any, opts: { tenantId?: string } = {}) {
  return {
    database: db,
    currentUser,
    currentTenant: { id: opts.tenantId || TENANT },
    language: 'en',
  } as any;
}

describe('VisitorLog — guard-registered visit attribution (station → postSite → client)', () => {
  beforeEach(() => {
    // Side-effects: keep the real attribution + denorm + findById logic, stub the rest.
    sinon.stub(AuditLogRepository, 'log').resolves(undefined as any);
    sinon.stub(FileRepository, 'replaceRelationFiles').resolves(undefined as any);
    sinon.stub(FileRepository, 'fillDownloadUrl').resolves([] as any);
  });
  afterEach(() => sinon.restore());

  it('resolves station → postSite → client from the guard CURRENT SHIFT when the worker sends none', async () => {
    // Worker-app sends no station (guard on duty via scheduler) → server resolves
    // from the current scheduled shift, then completes the chain.
    const db = buildDb({
      shifts: [
        {
          guardId: 'guard-1',
          tenantId: TENANT,
          startTime: new Date(Date.now() - 3600_000),
          endTime: new Date(Date.now() + 3600_000),
          stationId: 'station-9',
          postSiteId: null,
        },
      ],
      stations: [{ id: 'station-9', postSiteId: 'post-7', stationName: 'Lobby Norte' }],
      businessInfos: [{ id: 'post-7', clientAccountId: 'client-3' }],
      clientAccounts: [{ id: 'client-3', name: 'ACME' }],
    });

    const options = makeOptions(db, { id: 'guard-1' });
    const created = await VisitorLogRepository.create(
      { firstName: 'Juan', lastName: 'Perez', idNumber: '0102030405' },
      options,
    );

    assert.strictEqual(created.stationId, 'station-9', 'station resolved from current shift');
    assert.strictEqual(created.postSiteId, 'post-7', 'postSite completed from station');
    assert.strictEqual(created.clientId, 'client-3', 'client completed from postSite');
    // Denormalized station name pulled from the station record.
    assert.strictEqual(created.stationName, 'Lobby Norte');
    // The owning client object is hydrated for the consuming UIs.
    assert.ok(created.client && created.client.id === 'client-3');
  });

  it('falls back to the ACTIVE CLOCK-IN (guardShift) when there is no scheduled shift', async () => {
    const db = buildDb({
      shifts: [], // no scheduled shift right now
      securityGuards: [{ id: 'sg-1', guardId: 'guard-2', tenantId: TENANT, deletedAt: null }],
      guardShifts: [
        {
          guardNameId: 'sg-1',
          tenantId: TENANT,
          punchOutTime: null, // still clocked in
          punchInTime: new Date(),
          stationNameId: 'station-5',
          postSiteId: 'post-4',
        },
      ],
      stations: [{ id: 'station-5', postSiteId: 'post-4', stationName: 'Garita 2' }],
      businessInfos: [{ id: 'post-4', clientAccountId: 'client-8' }],
      clientAccounts: [{ id: 'client-8', name: 'Globex' }],
    });

    const options = makeOptions(db, { id: 'guard-2' });
    const created = await VisitorLogRepository.create(
      { firstName: 'Ana', lastName: 'Lopez' },
      options,
    );

    assert.strictEqual(created.stationId, 'station-5', 'station from active clock-in (stationNameId)');
    assert.strictEqual(created.postSiteId, 'post-4', 'postSite from active clock-in');
    assert.strictEqual(created.clientId, 'client-8', 'client completed from postSite');
  });

  it('falls back to the PERMANENT STATION JUNCTION when no shift/clock-in exists', async () => {
    const db = buildDb({
      shifts: [],
      securityGuards: [],
      guardShifts: [],
      stations: [
        {
          id: 'station-2',
          tenantId: TENANT,
          deletedAt: null,
          postSiteId: 'post-2',
          stationName: 'Recepción',
          _guardIds: ['guard-3'], // permanent station⇄guard junction
        },
      ],
      businessInfos: [{ id: 'post-2', clientAccountId: 'client-2' }],
      clientAccounts: [{ id: 'client-2', name: 'Initech' }],
    });

    const options = makeOptions(db, { id: 'guard-3' });
    const created = await VisitorLogRepository.create({ firstName: 'Beto' }, options);

    assert.strictEqual(created.stationId, 'station-2', 'station from permanent junction');
    assert.strictEqual(created.postSiteId, 'post-2');
    assert.strictEqual(created.clientId, 'client-2');
  });

  it('completes postSite → client from a worker-supplied stationId (the happy permanent-assignment path)', async () => {
    // Worker DID send a stationId (guard has a permanent junction + dashboard loaded).
    const db = buildDb({
      stations: [{ id: 'station-1', postSiteId: 'post-1', stationName: 'Main Gate' }],
      businessInfos: [{ id: 'post-1', clientAccountId: 'client-1' }],
      clientAccounts: [{ id: 'client-1', name: 'Stark' }],
    });

    const options = makeOptions(db, { id: 'guard-x' });
    const created = await VisitorLogRepository.create(
      { firstName: 'Tony', stationId: 'station-1', stationName: 'Main Gate' },
      options,
    );

    assert.strictEqual(created.stationId, 'station-1');
    assert.strictEqual(created.postSiteId, 'post-1', 'postSite derived from station');
    assert.strictEqual(created.clientId, 'client-1', 'client derived from postSite');
  });

  it('does not crash and leaves attribution empty when nothing can be resolved', async () => {
    const db = buildDb({}); // empty — no shift/clock-in/junction/post
    const options = makeOptions(db, { id: 'guard-orphan' });
    const created = await VisitorLogRepository.create({ firstName: 'Nadie' }, options);

    assert.strictEqual(created.stationId, undefined);
    assert.strictEqual(created.postSiteId, undefined);
    assert.strictEqual(created.clientId, undefined);
    // Still stamped with creator + tenant so the creator can read it back.
    assert.strictEqual(created.createdById, 'guard-orphan');
    assert.strictEqual(created.tenantId, TENANT);
  });

  it('stamps createdById + tenantId on the persisted row (creator read-back contract)', async () => {
    const db = buildDb({
      stations: [{ id: 's', postSiteId: 'p', stationName: 'X' }],
      businessInfos: [{ id: 'p', clientAccountId: 'c' }],
      clientAccounts: [{ id: 'c' }],
    });
    const options = makeOptions(db, { id: 'guard-9' });
    await VisitorLogRepository.create({ firstName: 'Z', stationId: 's' }, options);

    const persisted = db._state.visitorLogs[0];
    assert.strictEqual(persisted.createdById, 'guard-9');
    assert.strictEqual(persisted.tenantId, TENANT);
  });
});

describe('VisitorLog — read ACL (_buildAssignedVisitorLogAcl)', () => {
  it('returns NO ACL for an admin (admin sees every tenant row)', async () => {
    const db = buildDb();
    const adminUser = {
      id: 'admin-1',
      tenants: [{ tenant: { id: TENANT }, status: 'active', roles: [Roles.values.admin] }],
    };
    const acl = await (VisitorLogRepository as any)._buildAssignedVisitorLogAcl(
      makeOptions(db, adminUser),
    );
    assert.strictEqual(acl, null, 'admin → null ACL (no row filtering)');
  });

  it('lets a guard ALWAYS read rows they themselves created (createdById clause), even out of scope', async () => {
    // Guard has NO assigned posts/stations → ACL must still include createdById.
    const db = buildDb({ tenantUsers: [{ id: 'tu-1', userId: 'guard-1', tenantId: TENANT }] });
    const guardUser = {
      id: 'guard-1',
      tenants: [{ tenant: { id: TENANT }, status: 'active', roles: ['guard'], id: 'tu-1', assignedPostSites: [] }],
    };
    const acl = await (VisitorLogRepository as any)._buildAssignedVisitorLogAcl(
      makeOptions(db, guardUser),
    );
    assert.ok(acl && acl.hasAssigned, 'non-admin gets a scoped ACL');
    // With no posts/stations the only clause is the bare createdById object.
    assert.deepStrictEqual(acl.where, { createdById: 'guard-1' });
  });

  it('scopes a customer (client portal) to posts owned by their clientAccountId', async () => {
    const db = buildDb({
      tenantUsers: [{ id: 'tu-c', userId: 'cust-1', tenantId: TENANT }],
      businessInfos: [
        { id: 'post-A', tenantId: TENANT, clientAccountId: 'client-77' },
        { id: 'post-B', tenantId: TENANT, clientAccountId: 'client-77' },
        { id: 'post-Z', tenantId: TENANT, clientAccountId: 'other-client' },
      ],
    });
    const customer = {
      id: 'cust-1',
      clientAccountId: 'client-77',
      tenants: [{ tenant: { id: TENANT }, status: 'active', roles: ['customer'], id: 'tu-c', assignedPostSites: [] }],
    };
    const acl = await (VisitorLogRepository as any)._buildAssignedVisitorLogAcl(
      makeOptions(db, customer),
    );
    assert.ok(acl && acl.hasAssigned);
    // OR of [createdById, postSiteId IN client's posts].
    const orClauses = acl.where[Op.or];
    assert.ok(Array.isArray(orClauses), 'multiple clauses → Op.or');
    const postClause = orClauses.find((c: any) => c.postSiteId);
    assert.ok(postClause, 'customer gets a postSiteId IN (...) clause');
    const ids = postClause.postSiteId[Op.in];
    assert.deepStrictEqual(ids.sort(), ['post-A', 'post-B'], 'only the customer\'s own posts');
    assert.ok(!ids.includes('post-Z'), 'never another client\'s post');
  });

  it('includes assigned post sites + direct guard-station assignments in the ACL', async () => {
    const db = buildDb({
      tenantUsers: [{ id: 'tu-2', userId: 'sup-1', tenantId: TENANT }],
      stations: [{ id: 'station-G', tenantId: TENANT, deletedAt: null, postSiteId: 'post-from-station', _guardIds: ['sup-1'] }],
    });
    const supervisor = {
      id: 'sup-1',
      tenants: [
        {
          tenant: { id: TENANT },
          status: 'active',
          roles: ['supervisor'],
          id: 'tu-2',
          assignedPostSites: [{ id: 'post-assigned' }],
        },
      ],
    };
    const acl = await (VisitorLogRepository as any)._buildAssignedVisitorLogAcl(
      makeOptions(db, supervisor),
    );
    const orClauses = acl.where[Op.or];
    const postClause = orClauses.find((c: any) => c.postSiteId);
    const stationClause = orClauses.find((c: any) => c.stationId);
    assert.ok(postClause, 'post clause present');
    assert.ok(stationClause, 'station clause present');
    const postIds = postClause.postSiteId[Op.in].sort();
    assert.ok(postIds.includes('post-assigned'), 'assigned post site included');
    assert.ok(postIds.includes('post-from-station'), 'station-derived post site included');
    assert.deepStrictEqual(stationClause.stationId[Op.in], ['station-G'], 'direct guard station included');
  });
});

describe('VisitorLog — ACL applied end-to-end on reads', () => {
  beforeEach(() => {
    sinon.stub(FileRepository, 'fillDownloadUrl').resolves([] as any);
  });
  afterEach(() => sinon.restore());

  it('findAndCountAll returns ONLY rows the customer is allowed to see', async () => {
    const db = buildDb({
      tenantUsers: [{ id: 'tu-c', userId: 'cust-1', tenantId: TENANT }],
      businessInfos: [{ id: 'post-A', tenantId: TENANT, clientAccountId: 'client-77' }],
      visitorLogs: [
        // visible: belongs to the customer's post
        { id: 'v-own', tenantId: TENANT, postSiteId: 'post-A', createdById: 'guard-x', firstName: 'Mine' },
        // hidden: another client's post, not created by this customer
        { id: 'v-other', tenantId: TENANT, postSiteId: 'post-Z', createdById: 'guard-x', firstName: 'Theirs' },
      ],
    });
    const customer = {
      id: 'cust-1',
      clientAccountId: 'client-77',
      tenants: [{ tenant: { id: TENANT }, status: 'active', roles: ['customer'], id: 'tu-c', assignedPostSites: [] }],
    };

    const { rows, count } = await VisitorLogRepository.findAndCountAll(
      { filter: {}, limit: 50, offset: 0, orderBy: '' },
      makeOptions(db, customer),
    );
    assert.strictEqual(count, 1, 'only the owned visit is counted');
    assert.strictEqual(rows[0].id, 'v-own');
  });

  it('findAndCountAll surfaces a visit a guard created even when it is outside their post scope', async () => {
    const db = buildDb({
      tenantUsers: [{ id: 'tu-g', userId: 'guard-1', tenantId: TENANT }],
      visitorLogs: [
        // No post assigned to the guard, but the guard created this row → must show.
        { id: 'v-mine', tenantId: TENANT, postSiteId: 'post-elsewhere', createdById: 'guard-1', firstName: 'JustLogged' },
        { id: 'v-not-mine', tenantId: TENANT, postSiteId: 'post-elsewhere', createdById: 'someone-else', firstName: 'Nope' },
      ],
    });
    const guardUser = {
      id: 'guard-1',
      tenants: [{ tenant: { id: TENANT }, status: 'active', roles: ['guard'], id: 'tu-g', assignedPostSites: [] }],
    };

    const { rows, count } = await VisitorLogRepository.findAndCountAll(
      { filter: {}, limit: 50, offset: 0, orderBy: '' },
      makeOptions(db, guardUser),
    );
    assert.strictEqual(count, 1, 'guard sees exactly their own just-registered visit');
    assert.strictEqual(rows[0].id, 'v-mine');
  });
});
