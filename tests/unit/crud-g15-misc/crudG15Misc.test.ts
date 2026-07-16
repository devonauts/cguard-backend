/**
 * Unit tests — CRUD persistence fidelity for the g15-misc group.
 *
 * Context: tenants report "things are not being saved". The classic causes are
 * (1) a handler accepts a field but the repository DROPS it before the write,
 * (2) update paths whose where-clause / whitelist silently ignores changes,
 * (3) swallowed errors (try/catch returning success anyway).
 *
 * Covered (REAL repository/service/handler code against a Sequelize-shaped
 * fake db — no MySQL, no network):
 *   - supervisorPosition handlers        create/update/assign/destroy (full
 *                                        express handlers via route capture)
 *   - supervisorProfileService           updateSupervisor field fidelity +
 *                                        lazy profile creation + 404
 *   - supervisorLicense handlers         create/update (+ file relations)
 *   - video device / relay-site / event  create + update handlers (password &
 *                                        publish-token encryption, 404, 500)
 *   - radioCheckService                  upsertSettings fidelity + clamping,
 *                                        radioSettingsPut / radioEntryEscalate
 *   - serviceRepository                  create/update (+ tax snapshot, files)
 *   - additionalServiceRepository        create/update (BUG: update wipes
 *                                        stationsId when `stations` omitted)
 *   - bannerSuperiorAppRepository        create/update (+ imageUrl relation)
 *   - deviceIdInformationRepository      create/update (+ service rollback)
 *   - supervisor (worker app)            POST /supervisor/me/location write path
 *
 * Skipped modules: radio (LiveKit token minting only, no persistence),
 * smsAccount (all writes go through the Twilio API service, no local CRUD).
 *
 * Run:
 *   cross-env NODE_ENV=test TS_NODE_PROJECT=tsconfig.test.json \
 *     npx mocha -r ts-node/register \
 *     'tests/unit/crud-g15-misc/**\/*.test.ts' --exit --timeout 20000
 */

import assert from 'assert';
import sinon from 'sinon';
import Sequelize from 'sequelize';

import AuditLogRepository from '../../../src/database/repositories/auditLogRepository';
import FileRepository from '../../../src/database/repositories/fileRepository';
import Error404 from '../../../src/errors/Error404';

import ServiceRepository from '../../../src/database/repositories/serviceRepository';
import AdditionalServiceRepository from '../../../src/database/repositories/additionalServiceRepository';
import BannerSuperiorAppRepository from '../../../src/database/repositories/bannerSuperiorAppRepository';
import DeviceIdInformationRepository from '../../../src/database/repositories/deviceIdInformationRepository';
import DeviceIdInformationService from '../../../src/services/deviceIdInformationService';

import supervisorPositionRoutes from '../../../src/api/supervisorPosition';
import { updateSupervisor } from '../../../src/services/supervisorProfileService';
import { createSupervisorLicense, updateSupervisorLicense } from '../../../src/api/supervisorProfile/supervisorLicenses';

import videoDeviceCreate from '../../../src/api/video/deviceCreate';
import videoDeviceUpdate from '../../../src/api/video/deviceUpdate';
import relaySiteCreate from '../../../src/api/video/relaySiteCreate';
import relaySiteUpdate from '../../../src/api/video/relaySiteUpdate';
import videoEventCreate from '../../../src/api/video/eventCreate';
import videoEventUpdate from '../../../src/api/video/eventUpdate';

import { upsertSettings } from '../../../src/services/radioCheckService';
import { radioSettingsPut, radioEntryEscalate } from '../../../src/api/radioCheck/radioCheckEndpoints';

import updateMyLocation from '../../../src/api/supervisor/meLocation';

import { isEncrypted, decrypt } from '../../../src/lib/secretBox';

const Op = Sequelize.Op;

const TENANT = 'tenant-A';
const OTHER_TENANT = 'tenant-B';
const USER_ID = 'user-1';

// ──────────────────────── makeRow / fake db (Sequelize-shaped) ───────────────
function makeRow(data: any) {
  const row: any = {
    deletedAt: null,
    ...data,
    __updateCalls: [] as any[],
    __destroyed: false,
    get(opts?: any) {
      const plain: any = {};
      for (const k of Object.keys(row)) {
        if (k.startsWith('__') || typeof row[k] === 'function') continue;
        plain[k] = row[k];
      }
      return opts && opts.plain ? { ...plain } : plain;
    },
    async update(patch: any) {
      row.__updateCalls.push({ ...patch });
      for (const [k, v] of Object.entries(patch)) {
        if (v !== undefined) row[k] = v;
      }
      return row;
    },
    async reload() {
      return row;
    },
    async destroy() {
      row.__destroyed = true;
      return row;
    },
    // file-relation getters the repos' findById enrichers call
    async getImageUrl() { return []; },
    async getIconImage() { return []; },
    async getServiceImages() { return []; },
    async getFrontImage() { return []; },
    async getBackImage() { return []; },
  };
  return row;
}

/** Where matcher supporting plain equality + Op.ne / Op.in / Op.and / Op.or. */
function matchWhere(row: any, where: any): boolean {
  if (!where) return true;
  for (const key of Reflect.ownKeys(where)) {
    const cond = (where as any)[key];
    if (key === Op.and) {
      const parts = Array.isArray(cond) ? cond : [cond];
      if (!parts.every((p) => matchWhere(row, p))) return false;
      continue;
    }
    if (key === Op.or) {
      const parts = Array.isArray(cond) ? cond : [cond];
      if (!parts.some((p) => matchWhere(row, p))) return false;
      continue;
    }
    if (typeof key === 'symbol') continue; // other operators unused here
    if (cond !== null && typeof cond === 'object' && !Array.isArray(cond) && !(cond instanceof Date)) {
      const syms = Object.getOwnPropertySymbols(cond);
      if (syms.length) {
        for (const s of syms) {
          const v = (cond as any)[s];
          if (s === Op.ne && row[key as string] === v) return false;
          if (s === Op.in && !(Array.isArray(v) && v.includes(row[key as string]))) return false;
        }
        continue;
      }
    }
    if (row[key as string] !== cond) return false;
  }
  return true;
}

function makeModel(name: string, seed: any[] = []) {
  const model: any = {
    __name: name,
    rows: seed.map(makeRow),
    calls: {
      create: [] as any[],
      findOne: [] as any[],
      findAll: [] as any[],
      update: [] as any[],
      destroy: [] as any[],
      increment: [] as any[],
    },
    getTableName: () => `${name}s`,
    async create(data: any) {
      model.calls.create.push({ ...data });
      const row = makeRow({ id: data.id || `${name}-${model.rows.length + 1}`, ...data });
      model.rows.push(row);
      return row;
    },
    async findOne(q: any = {}) {
      model.calls.findOne.push(q);
      return model.rows.find((r: any) => !r.__destroyed && matchWhere(r, q.where)) || null;
    },
    async findAll(q: any = {}) {
      model.calls.findAll.push(q);
      return model.rows.filter((r: any) => !r.__destroyed && matchWhere(r, q.where));
    },
    async findByPk(id: any) {
      return model.rows.find((r: any) => r.id === id) || null;
    },
    // Static Model.update(values, { where }) — records the call, applies it.
    async update(values: any, q: any = {}) {
      model.calls.update.push({ values: { ...values }, where: q.where });
      const victims = model.rows.filter((r: any) => !r.__destroyed && matchWhere(r, q.where));
      victims.forEach((r: any) => {
        for (const [k, v] of Object.entries(values)) {
          if (v !== undefined) r[k] = v;
        }
      });
      return [victims.length];
    },
    async increment(field: any, q: any = {}) {
      model.calls.increment.push({ field, where: q.where });
      const victims = model.rows.filter((r: any) => matchWhere(r, q.where));
      victims.forEach((r: any) => { r[field] = (r[field] || 0) + 1; });
      return victims.length;
    },
    async count(q: any = {}) {
      return model.rows.filter((r: any) => !r.__destroyed && matchWhere(r, q.where)).length;
    },
    async destroy(q: any = {}) {
      model.calls.destroy.push(q);
      const victims = model.rows.filter((r: any) => matchWhere(r, q.where));
      victims.forEach((r: any) => (r.__destroyed = true));
      return victims.length;
    },
  };
  return model;
}

function buildDb(seed: Record<string, any[]> = {}) {
  const names = [
    'supervisorPosition', 'supervisorPositionAssignment', 'supervisorScheduledShift',
    'rotationStyle', 'user', 'tenant', 'tenantUser', 'file',
    'supervisorProfile', 'supervisorShift', 'supervisorLicense', 'licenseType',
    'videoDevice', 'videoRelaySite', 'videoEvent',
    'radioCheckSettings', 'radioCheckSession', 'radioCheckEntry',
    'service', 'tax', 'additionalService', 'station',
    'bannerSuperiorApp', 'deviceIdInformation', 'locationPing',
  ];
  const db: any = {};
  for (const n of names) db[n] = makeModel(n, seed[n] || []);
  db.Sequelize = Sequelize;
  db.sequelize = {
    __commits: 0,
    __rollbacks: 0,
    async transaction() {
      const s = db.sequelize;
      return {
        async commit() { s.__commits += 1; },
        async rollback() { s.__rollbacks += 1; },
      };
    },
  };
  return db;
}

// Admin-shaped current user: passes PermissionChecker for every gate used here.
function adminUser(tenantId = TENANT) {
  return {
    id: USER_ID,
    emailVerified: true,
    tenants: [{ tenant: { id: tenantId }, status: 'active', roles: ['admin'] }],
  };
}

function repoOptions(db: any, tenantId = TENANT) {
  return {
    currentUser: adminUser(tenantId),
    currentTenant: { id: tenantId },
    language: 'es',
    database: db,
  } as any;
}

function fakeReq(db: any, extra: any = {}) {
  return {
    currentUser: adminUser(),
    currentTenant: { id: TENANT },
    language: 'es',
    database: db,
    params: {},
    body: {},
    query: {},
    ...extra,
  } as any;
}

function fakeRes() {
  const res: any = { statusCode: 200, body: undefined };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: any) => { res.body = b; return res; };
  res.send = (b: any) => { res.body = b; return res; };
  res.sendStatus = (c: number) => { res.statusCode = c; return res; };
  res.header = () => res;
  return res;
}

/** Capture the express routes a `(app) => {...}` module registers. */
function captureRoutes(registrar: (app: any) => void) {
  const routes: Record<string, Function> = {};
  const rec = (m: string) => (p: string, h: Function) => { routes[`${m} ${p}`] = h; };
  registrar({ get: rec('GET'), post: rec('POST'), put: rec('PUT'), delete: rec('DELETE'), patch: rec('PATCH') });
  return routes;
}

// Stub the cross-cutting side channels (audit log + file relations) — they are
// not the persistence under test.
beforeEach(() => {
  if ((AuditLogRepository as any).log?.restore) (AuditLogRepository as any).log.restore();
  sinon.stub(AuditLogRepository, 'log').resolves();
  if ((FileRepository as any).replaceRelationFiles?.restore) (FileRepository as any).replaceRelationFiles.restore();
  sinon.stub(FileRepository, 'replaceRelationFiles').resolves();
  if ((FileRepository as any).fillDownloadUrl?.restore) (FileRepository as any).fillDownloadUrl.restore();
  sinon.stub(FileRepository, 'fillDownloadUrl').resolves(null as any);
});
afterEach(() => sinon.restore());

// ═══════════════════════════ supervisorPosition ═════════════════════════════
// Every writable field the CRM "Puestos de supervisor" form can send (POS_FIELDS
// whitelist == every non-audit column of the supervisorPosition model).
const POSITION_FULL = {
  name: 'Aguila2',
  zone: 'Norte de Quito',
  scheduleType: '24h',
  rotationStyleId: 'rot-1',
  startTime: '06:00',
  endTime: '18:00',
  guardsNeeded: 2,
  mobileStationId: 'st-mobile-1',
  stationIds: ['st-1', 'st-2'],
  isActive: true,
};

const posRoutes = captureRoutes(supervisorPositionRoutes);

describe('crud-g15 · supervisorPosition create handler', () => {
  it('persists EVERY writable field the form sends (field fidelity) + stamps', async () => {
    const db = buildDb();
    const req = fakeReq(db, { body: { data: { ...POSITION_FULL } } });
    const res = fakeRes();
    await posRoutes['POST /tenant/:tenantId/supervisor-positions'](req, res);

    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.strictEqual(db.supervisorPosition.calls.create.length, 1);
    const written = db.supervisorPosition.calls.create[0];
    for (const [k, v] of Object.entries(POSITION_FULL)) {
      assert.deepStrictEqual(written[k], v, `field "${k}" was dropped or altered on create`);
    }
    assert.strictEqual(written.tenantId, TENANT);
    assert.strictEqual(written.createdById, USER_ID);
    assert.strictEqual(written.updatedById, USER_ID);
  });

  it('a db failure surfaces as an error response (5xx), NEVER a fake success', async () => {
    const db = buildDb();
    db.supervisorPosition.create = async () => { throw new Error('insert failed'); };
    const req = fakeReq(db, { body: { data: { ...POSITION_FULL } } });
    const res = fakeRes();
    await posRoutes['POST /tenant/:tenantId/supervisor-positions'](req, res);
    assert.ok(res.statusCode >= 500, `db failure must not produce a success (got ${res.statusCode})`);
  });
});

describe('crud-g15 · supervisorPosition update handler', () => {
  const seedPos = (over: any = {}) => ({ id: 'pos-1', tenantId: TENANT, ...POSITION_FULL, ...over });

  it('targets the right row (id + tenantId) and applies EVERY changed field', async () => {
    const db = buildDb({ supervisorPosition: [seedPos()] });
    const patch = {
      name: 'Aguila3',
      zone: 'Valle de los Chillos',
      scheduleType: '12h-day',
      rotationStyleId: 'rot-2',
      startTime: '07:00',
      endTime: '19:00',
      guardsNeeded: 3,
      mobileStationId: 'st-mobile-2',
      stationIds: ['st-9'],
      isActive: false,
    };
    const req = fakeReq(db, { params: { id: 'pos-1' }, body: { data: { ...patch } } });
    const res = fakeRes();
    await posRoutes['PUT /tenant/:tenantId/supervisor-positions/:id'](req, res);

    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    const q = db.supervisorPosition.calls.findOne[0];
    assert.strictEqual(q.where.id, 'pos-1');
    assert.strictEqual(q.where.tenantId, TENANT);

    const applied = db.supervisorPosition.rows[0].__updateCalls[0];
    for (const [k, v] of Object.entries(patch)) {
      assert.deepStrictEqual(applied[k], v, `field "${k}" silently ignored on update`);
    }
    assert.strictEqual(applied.updatedById, USER_ID);
  });

  it('updating a position of ANOTHER tenant returns 404 and writes nothing', async () => {
    const db = buildDb({ supervisorPosition: [seedPos({ tenantId: OTHER_TENANT })] });
    const req = fakeReq(db, { params: { id: 'pos-1' }, body: { data: { name: 'hijack' } } });
    const res = fakeRes();
    await posRoutes['PUT /tenant/:tenantId/supervisor-positions/:id'](req, res);
    assert.strictEqual(res.statusCode, 404);
    assert.strictEqual(db.supervisorPosition.rows[0].__updateCalls.length, 0);
  });
});

describe('crud-g15 · supervisorPosition assignment handler', () => {
  it('persists EVERY assignment field + positionId/tenant stamps and defaults startDate', async () => {
    const db = buildDb({ supervisorPosition: [{ id: 'pos-1', tenantId: TENANT, ...POSITION_FULL }] });
    const asg = {
      supervisorUserId: 'sup-7',
      endDate: '2026-12-31',
      platoonOffset: 2,
      isRelief: true,
      status: 'active',
    };
    const req = fakeReq(db, { params: { id: 'pos-1' }, body: { data: { ...asg } } });
    const res = fakeRes();
    await posRoutes['POST /tenant/:tenantId/supervisor-positions/:id/assignments'](req, res);

    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    const written = db.supervisorPositionAssignment.calls.create[0];
    for (const [k, v] of Object.entries(asg)) {
      assert.deepStrictEqual(written[k], v, `field "${k}" was dropped or altered on create`);
    }
    assert.strictEqual(written.positionId, 'pos-1');
    assert.strictEqual(written.tenantId, TENANT);
    assert.strictEqual(written.createdById, USER_ID);
    assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(written.startDate), 'startDate default missing');
  });

  it('destroy deletes the position AND its assignments (tenant-scoped)', async () => {
    const db = buildDb({
      supervisorPosition: [{ id: 'pos-1', tenantId: TENANT, ...POSITION_FULL }],
      supervisorPositionAssignment: [{ id: 'asg-1', tenantId: TENANT, positionId: 'pos-1' }],
    });
    const req = fakeReq(db, { params: { id: 'pos-1' } });
    const res = fakeRes();
    await posRoutes['DELETE /tenant/:tenantId/supervisor-positions/:id'](req, res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(db.supervisorPosition.rows[0].__destroyed, true);
    const dq = db.supervisorPositionAssignment.calls.destroy[0];
    assert.strictEqual(dq.where.positionId, 'pos-1');
    assert.strictEqual(dq.where.tenantId, TENANT);
  });
});

// ═══════════════════════════ supervisorProfile ══════════════════════════════
// Every profile field the CRM supervisor form can send (WRITABLE_PROFILE).
const SUPERVISOR_PROFILE_FULL = {
  governmentId: '1712345678',
  gender: 'M',
  bloodType: 'O+',
  birthDate: '1990-04-12',
  birthPlace: 'Quito',
  maritalStatus: 'casado',
  academicInstruction: 'Bachiller',
  address: 'Av. Amazonas N34-56',
  latitude: -0.18,
  longitude: -78.47,
  hiringContractDate: '2025-01-15',
  guardCredentials: 'Credencial MDI 998',
  availability: 'Tiempo completo',
  languages: ['es', 'en'],
  skills: ['manejo', 'primeros auxilios'],
  zone: 'Norte',
  assignedVehicle: 'PBX-1234',
  turnoDays: ['lun', 'mar', 'mie'],
  turnoStart: '06:00',
  turnoEnd: '18:00',
  mobileStationId: 'st-mobile-1',
};

function seedSupervisorDb(over: Record<string, any[]> = {}) {
  const user = makeRow({ id: 'sup-user-1', email: 'sup@x.com', firstName: 'Luis', lastName: 'Vera', fullName: 'Luis Vera' });
  const db = buildDb({
    supervisorProfile: over.supervisorProfile ?? [
      { id: 'prof-1', tenantId: TENANT, supervisorUserId: 'sup-user-1', fullName: 'Luis Vera' },
    ],
    ...over,
  });
  db.tenantUser.rows = (over.tenantUser
    ? over.tenantUser.map(makeRow)
    : [makeRow({ id: 'tu-1', tenantId: TENANT, userId: 'sup-user-1', status: 'active', roles: ['securitySupervisor'] })]);
  db.tenantUser.rows.forEach((r: any) => { r.user = user; });
  return db;
}

describe('crud-g15 · supervisorProfileService.updateSupervisor', () => {
  it('applies EVERY writable profile field onto the profile row (field fidelity)', async () => {
    const db = seedSupervisorDb();
    const req = fakeReq(db, { body: { ...SUPERVISOR_PROFILE_FULL } });
    await updateSupervisor(req, 'sup-user-1');

    const profile = db.supervisorProfile.rows[0];
    assert.strictEqual(profile.__updateCalls.length, 1);
    const applied = profile.__updateCalls[0];
    for (const [k, v] of Object.entries(SUPERVISOR_PROFILE_FULL)) {
      assert.deepStrictEqual(applied[k], v, `field "${k}" silently ignored on update`);
    }
    assert.strictEqual(applied.updatedById, USER_ID);
    // profile lookup was tenant-scoped
    const q = db.supervisorProfile.calls.findOne[0];
    assert.strictEqual(q.where.tenantId, TENANT);
    assert.strictEqual(q.where.supervisorUserId, 'sup-user-1');
  });

  it('lazily creates the profile row (tenant + user + fullName) when missing', async () => {
    const db = seedSupervisorDb({ supervisorProfile: [] });
    const req = fakeReq(db, { body: { zone: 'Sur' } });
    await updateSupervisor(req, 'sup-user-1');

    assert.strictEqual(db.supervisorProfile.calls.create.length, 1);
    const created = db.supervisorProfile.calls.create[0];
    assert.strictEqual(created.tenantId, TENANT);
    assert.strictEqual(created.supervisorUserId, 'sup-user-1');
    assert.strictEqual(created.fullName, 'Luis Vera');
    // and the patch was applied on top
    assert.strictEqual(db.supervisorProfile.rows[0].zone, 'Sur');
  });

  it('throws Error404 for a user in ANOTHER tenant (no silent cross-tenant write)', async () => {
    const db = seedSupervisorDb({
      tenantUser: [{ id: 'tu-1', tenantId: OTHER_TENANT, userId: 'sup-user-1', status: 'active', roles: ['securitySupervisor'] }],
    });
    const req = fakeReq(db, { body: { zone: 'X' } });
    await assert.rejects(() => updateSupervisor(req, 'sup-user-1'), Error404);
    assert.strictEqual(db.supervisorProfile.rows[0].__updateCalls.length, 0);
  });
});

// Every license field the CRM form can send (FIELDS whitelist).
const LICENSE_FULL = {
  licenseTypeId: 'lt-1',
  customName: 'Licencia tipo B',
  number: 'LIC-2026-778',
  issueDate: '2026-01-10',
  expiryDate: '2028-01-10',
  importHash: 'hash-lic-1',
};

describe('crud-g15 · supervisorLicense handlers', () => {
  it('create persists EVERY field + supervisorUserId/tenant stamps and wires both images', async () => {
    const db = buildDb();
    const frontImage = [{ id: 'f-1', name: 'front.jpg' }];
    const backImage = [{ id: 'f-2', name: 'back.jpg' }];
    const req = fakeReq(db, { params: { userId: 'sup-user-1' }, body: { ...LICENSE_FULL, frontImage, backImage } });
    const res = fakeRes();
    await createSupervisorLicense(req, res);

    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    const written = db.supervisorLicense.calls.create[0];
    for (const [k, v] of Object.entries(LICENSE_FULL)) {
      assert.deepStrictEqual(written[k], v, `field "${k}" was dropped or altered on create`);
    }
    assert.strictEqual(written.supervisorUserId, 'sup-user-1');
    assert.strictEqual(written.tenantId, TENANT);
    assert.strictEqual(written.createdById, USER_ID);

    const stub = FileRepository.replaceRelationFiles as sinon.SinonStub;
    const cols = stub.getCalls().map((c) => c.args[0].belongsToColumn);
    assert.ok(cols.includes('frontImage'), 'frontImage relation not written');
    assert.ok(cols.includes('backImage'), 'backImage relation not written');
  });

  it('update targets licenseId + tenantId + supervisorUserId and applies EVERY field', async () => {
    const db = buildDb({
      supervisorLicense: [{ id: 'lic-1', tenantId: TENANT, supervisorUserId: 'sup-user-1', ...LICENSE_FULL }],
    });
    const patch = {
      licenseTypeId: 'lt-2',
      customName: 'Licencia renovada',
      number: 'LIC-2027-001',
      issueDate: '2027-01-01',
      expiryDate: '2029-01-01',
      importHash: 'hash-lic-2',
    };
    const req = fakeReq(db, { params: { userId: 'sup-user-1', licenseId: 'lic-1' }, body: { ...patch } });
    const res = fakeRes();
    await updateSupervisorLicense(req, res);

    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    const q = db.supervisorLicense.calls.findOne[0];
    assert.strictEqual(q.where.id, 'lic-1');
    assert.strictEqual(q.where.tenantId, TENANT);
    assert.strictEqual(q.where.supervisorUserId, 'sup-user-1');

    const applied = db.supervisorLicense.rows[0].__updateCalls[0];
    for (const [k, v] of Object.entries(patch)) {
      assert.deepStrictEqual(applied[k], v, `field "${k}" silently ignored on update`);
    }
    assert.strictEqual(applied.updatedById, USER_ID);
    // No images in the body → relations untouched.
    assert.strictEqual((FileRepository.replaceRelationFiles as sinon.SinonStub).callCount, 0);
  });

  it('updating a license of ANOTHER tenant returns 404 and writes nothing', async () => {
    const db = buildDb({
      supervisorLicense: [{ id: 'lic-1', tenantId: OTHER_TENANT, supervisorUserId: 'sup-user-1', ...LICENSE_FULL }],
    });
    const req = fakeReq(db, { params: { userId: 'sup-user-1', licenseId: 'lic-1' }, body: { number: 'hijack' } });
    const res = fakeRes();
    await updateSupervisorLicense(req, res);
    assert.strictEqual(res.statusCode, 404);
    assert.strictEqual(db.supervisorLicense.rows[0].__updateCalls.length, 0);
  });

  it('a db failure on create returns 5xx, NEVER a fake success', async () => {
    const db = buildDb();
    db.supervisorLicense.create = async () => { throw new Error('insert failed'); };
    const req = fakeReq(db, { params: { userId: 'sup-user-1' }, body: { ...LICENSE_FULL } });
    const res = fakeRes();
    await createSupervisorLicense(req, res);
    assert.ok(res.statusCode >= 500, `db failure must not produce a success (got ${res.statusCode})`);
  });
});

// ═══════════════════════════ video ══════════════════════════════════════════
const VIDEO_DEVICE_FULL = {
  name: 'DVR Bodega Norte',
  type: 'dvr',
  brand: 'Hikvision',
  model: 'DS-7208',
  host: '10.0.0.20',
  port: 554,
  httpPort: 8080,
  username: 'admin',
  password: 'cam-secret',
  channels: 8,
  protocol: 'rtsp',
  status: 'online',
  lastSeenAt: '2026-07-14T10:00:00.000Z',
  postSiteId: 'ps-1',
  stationId: 'st-1',
  notes: 'DVR principal',
  connectionMode: 'relay',
  relaySiteId: 'rs-1',
  active: true,
};

describe('crud-g15 · video device create handler', () => {
  it('persists EVERY writable field, encrypts the password, never returns it', async () => {
    const db = buildDb();
    const req = fakeReq(db, { body: { ...VIDEO_DEVICE_FULL } });
    const res = fakeRes();
    await videoDeviceCreate(req, res);

    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    const written = db.videoDevice.calls.create[0];
    const { password, ...plainFields } = VIDEO_DEVICE_FULL;
    for (const [k, v] of Object.entries(plainFields)) {
      assert.deepStrictEqual(written[k], v, `field "${k}" was dropped or altered on create`);
    }
    assert.strictEqual(written.tenantId, TENANT);
    assert.strictEqual(written.createdById, USER_ID);
    assert.strictEqual(written.updatedById, USER_ID);
    assert.ok(isEncrypted(written.password), 'password not encrypted at rest');
    assert.strictEqual(decrypt(written.password), 'cam-secret');
    assert.strictEqual(res.body.password, undefined, 'password leaked in the response');
  });

  it('a db failure returns 5xx, NEVER a fake success', async () => {
    const db = buildDb();
    db.videoDevice.create = async () => { throw new Error('insert failed'); };
    const req = fakeReq(db, { body: { ...VIDEO_DEVICE_FULL } });
    const res = fakeRes();
    await videoDeviceCreate(req, res);
    assert.ok(res.statusCode >= 500, `db failure must not produce a success (got ${res.statusCode})`);
  });
});

describe('crud-g15 · video device update handler', () => {
  const seedDevice = (over: any = {}) => ({
    id: 'vd-1',
    tenantId: TENANT,
    ...VIDEO_DEVICE_FULL,
    password: 'enc-old-envelope',
    ...over,
  });

  it('targets id + tenantId and applies EVERY sent field; omitted password untouched', async () => {
    const db = buildDb({ videoDevice: [seedDevice()] });
    const patch = {
      name: 'DVR renombrado',
      type: 'nvr',
      brand: 'Dahua',
      model: 'NVR-4108',
      host: '10.0.0.99',
      port: 555,
      httpPort: 8081,
      username: 'root',
      channels: 16,
      protocol: 'rtsp',
      status: 'offline',
      lastSeenAt: '2026-07-15T08:00:00.000Z',
      postSiteId: 'ps-2',
      stationId: 'st-2',
      notes: 'movido a garita sur',
      active: false,
      connectionMode: 'direct',
      relaySiteId: null as any,
    };
    const req = fakeReq(db, { params: { id: 'vd-1' }, body: { ...patch } });
    const res = fakeRes();
    await videoDeviceUpdate(req, res);

    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    const q = db.videoDevice.calls.findOne[0];
    assert.strictEqual(q.where.id, 'vd-1');
    assert.strictEqual(q.where.tenantId, TENANT);

    const applied = db.videoDevice.rows[0].__updateCalls[0];
    for (const [k, v] of Object.entries(patch)) {
      assert.deepStrictEqual(applied[k], v, `field "${k}" silently ignored on update`);
    }
    assert.strictEqual(applied.updatedById, USER_ID);
    assert.strictEqual(applied.password, undefined, 'omitted password must not be touched');
    assert.strictEqual(db.videoDevice.rows[0].password, 'enc-old-envelope');
    assert.strictEqual(res.body.password, undefined, 'password leaked in the response');
  });

  it('an EMPTY password does not wipe the stored one; a new one is re-encrypted', async () => {
    const db = buildDb({ videoDevice: [seedDevice()] });
    let req = fakeReq(db, { params: { id: 'vd-1' }, body: { password: '' } });
    await videoDeviceUpdate(req, fakeRes());
    assert.strictEqual(db.videoDevice.rows[0].password, 'enc-old-envelope');

    req = fakeReq(db, { params: { id: 'vd-1' }, body: { password: 'new-cam-pass' } });
    await videoDeviceUpdate(req, fakeRes());
    assert.ok(isEncrypted(db.videoDevice.rows[0].password));
    assert.strictEqual(decrypt(db.videoDevice.rows[0].password), 'new-cam-pass');
  });

  it('updating a device of ANOTHER tenant returns 404 and writes nothing', async () => {
    const db = buildDb({ videoDevice: [seedDevice({ tenantId: OTHER_TENANT })] });
    const req = fakeReq(db, { params: { id: 'vd-1' }, body: { name: 'hijack' } });
    const res = fakeRes();
    await videoDeviceUpdate(req, res);
    assert.strictEqual(res.statusCode, 404);
    assert.strictEqual(db.videoDevice.rows[0].__updateCalls.length, 0);
  });
});

describe('crud-g15 · video relay-site create/update handlers', () => {
  it('create persists name/protocol/notes/active + a generated siteKey and ENCRYPTED publish token', async () => {
    const db = buildDb();
    const req = fakeReq(db, { body: { data: { name: 'Sitio Guayaquil', ingestProtocol: 'srt', notes: 'DVR tras NAT', active: false } } });
    const res = fakeRes();
    await relaySiteCreate(req, res);

    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    const written = db.videoRelaySite.calls.create[0];
    assert.strictEqual(written.name, 'Sitio Guayaquil');
    assert.strictEqual(written.ingestProtocol, 'srt');
    assert.strictEqual(written.notes, 'DVR tras NAT');
    assert.strictEqual(written.active, false);
    assert.strictEqual(written.tenantId, TENANT);
    assert.strictEqual(written.createdById, USER_ID);
    assert.ok(/^sitio-guayaquil-[0-9a-f]{6}$/.test(written.siteKey), `bad siteKey ${written.siteKey}`);
    assert.ok(isEncrypted(written.publishToken), 'publishToken not encrypted at rest');
    assert.strictEqual(res.body.publishToken, undefined, 'publishToken leaked in the response');
    assert.strictEqual(res.body.publishTokenConfigured, true);
  });

  it('update targets id + tenantId, applies the fields, and only rotates the token on regenToken', async () => {
    const db = buildDb({
      videoRelaySite: [{ id: 'rs-1', tenantId: TENANT, name: 'Sitio', siteKey: 'sitio-abc123', publishToken: 'enc-old-token', ingestProtocol: 'rtmps', notes: null, active: true }],
    });
    const req = fakeReq(db, { params: { id: 'rs-1' }, body: { data: { name: 'Sitio 2', ingestProtocol: 'srt', notes: 'nueva nota', active: false } } });
    const res = fakeRes();
    await relaySiteUpdate(req, res);

    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    const q = db.videoRelaySite.calls.findOne[0];
    assert.strictEqual(q.where.id, 'rs-1');
    assert.strictEqual(q.where.tenantId, TENANT);
    const applied = db.videoRelaySite.rows[0].__updateCalls[0];
    assert.strictEqual(applied.name, 'Sitio 2');
    assert.strictEqual(applied.ingestProtocol, 'srt');
    assert.strictEqual(applied.notes, 'nueva nota');
    assert.strictEqual(applied.active, false);
    assert.strictEqual(applied.publishToken, undefined, 'token must NOT rotate without regenToken');

    // regenToken → new encrypted token
    const req2 = fakeReq(db, { params: { id: 'rs-1' }, body: { data: { regenToken: true } } });
    await relaySiteUpdate(req2, fakeRes());
    const row = db.videoRelaySite.rows[0];
    assert.ok(isEncrypted(row.publishToken), 'rotated token not encrypted');
    assert.notStrictEqual(row.publishToken, 'enc-old-token');
  });
});

const VIDEO_EVENT_FULL = {
  videoCameraId: 'cam-1',
  videoDeviceId: 'vd-1',
  type: 'motion',
  severity: 'high',
  at: '2026-07-14T22:15:00.000Z',
  title: 'Movimiento en bodega',
  description: 'Detección nocturna',
  status: 'new',
  videoClipId: 'clip-1',
  stationId: 'st-1',
  postSiteId: 'ps-1',
};

describe('crud-g15 · video event create/update handlers', () => {
  it('create persists EVERY field (incl. the parsed `at` date) + tenant stamp', async () => {
    const db = buildDb();
    const req = fakeReq(db, { body: { ...VIDEO_EVENT_FULL } });
    const res = fakeRes();
    await videoEventCreate(req, res);

    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    const written = db.videoEvent.calls.create[0];
    const { at, ...rest } = VIDEO_EVENT_FULL;
    for (const [k, v] of Object.entries(rest)) {
      assert.deepStrictEqual(written[k], v, `field "${k}" was dropped or altered on create`);
    }
    assert.ok(written.at instanceof Date, '`at` not stored as a date');
    assert.strictEqual(written.at.toISOString(), at);
    assert.strictEqual(written.tenantId, TENANT);
    assert.strictEqual(written.createdById, USER_ID);
  });

  it('update (ack/resolve) targets id + tenantId, applies the patch and stamps acknowledgedById', async () => {
    const db = buildDb({ videoEvent: [{ id: 've-1', tenantId: TENANT, ...VIDEO_EVENT_FULL }] });
    const req = fakeReq(db, {
      params: { id: 've-1' },
      body: { status: 'ack', severity: 'critical', title: 'Confirmado', description: 'intrusión real' },
    });
    const res = fakeRes();
    await videoEventUpdate(req, res);

    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    const q = db.videoEvent.calls.findOne[0];
    assert.strictEqual(q.where.id, 've-1');
    assert.strictEqual(q.where.tenantId, TENANT);
    const applied = db.videoEvent.rows[0].__updateCalls[0];
    assert.strictEqual(applied.status, 'ack');
    assert.strictEqual(applied.severity, 'critical');
    assert.strictEqual(applied.title, 'Confirmado');
    assert.strictEqual(applied.description, 'intrusión real');
    assert.strictEqual(applied.acknowledgedById, USER_ID);
  });

  it('updating an event of ANOTHER tenant returns 404 and writes nothing', async () => {
    const db = buildDb({ videoEvent: [{ id: 've-1', tenantId: OTHER_TENANT, ...VIDEO_EVENT_FULL }] });
    const req = fakeReq(db, { params: { id: 've-1' }, body: { status: 'resolved' } });
    const res = fakeRes();
    await videoEventUpdate(req, res);
    assert.strictEqual(res.statusCode, 404);
    assert.strictEqual(db.videoEvent.rows[0].__updateCalls.length, 0);
  });
});

// ═══════════════════════════ radioCheck ═════════════════════════════════════
// Every settings field the CRM "pase de novedades" config can send.
const RADIO_SETTINGS_FULL = {
  enabled: true,
  intervalMinutes: 45,
  perStationTimeoutSeconds: 240,
  activeHoursStart: '20:00',
  activeHoursEnd: '06:00',
  promptText: '¿Alguna novedad en el puesto?',
  voiceAnnouncement: true,
  channel: 'app',
};

describe('crud-g15 · radioCheckService.upsertSettings', () => {
  const seedSettings = () => ({
    id: 'rcs-1', tenantId: TENANT, enabled: false, intervalMinutes: 35,
    perStationTimeoutSeconds: 180, activeHoursStart: null, activeHoursEnd: null,
    promptText: 'x', voiceAnnouncement: false, channel: 'app',
  });

  it('persists EVERY allowed field onto the tenant settings row + updatedById', async () => {
    const db = buildDb({ radioCheckSettings: [seedSettings()] });
    await upsertSettings(db, TENANT, { ...RADIO_SETTINGS_FULL }, USER_ID);

    const q = db.radioCheckSettings.calls.findOne[0];
    assert.strictEqual(q.where.tenantId, TENANT);

    const applied = db.radioCheckSettings.rows[0].__updateCalls[0];
    for (const [k, v] of Object.entries(RADIO_SETTINGS_FULL)) {
      assert.deepStrictEqual(applied[k], v, `field "${k}" silently ignored on upsert`);
    }
    assert.strictEqual(applied.updatedById, USER_ID);
  });

  it('clamps intervalMinutes to [1,720] and perStationTimeoutSeconds to [30,1800]', async () => {
    const db = buildDb({ radioCheckSettings: [seedSettings()] });
    await upsertSettings(db, TENANT, { intervalMinutes: 99999, perStationTimeoutSeconds: 5 }, USER_ID);
    const row = db.radioCheckSettings.rows[0];
    assert.strictEqual(row.intervalMinutes, 720);
    assert.strictEqual(row.perStationTimeoutSeconds, 30);
  });

  it('lazily creates the settings row for a tenant that has none, then applies the patch', async () => {
    const db = buildDb();
    await upsertSettings(db, TENANT, { enabled: true }, USER_ID);
    assert.strictEqual(db.radioCheckSettings.calls.create.length, 1);
    assert.strictEqual(db.radioCheckSettings.calls.create[0].tenantId, TENANT);
    assert.strictEqual(db.radioCheckSettings.rows[0].enabled, true);
  });
});

describe('crud-g15 · radioCheck handlers', () => {
  it('radioSettingsPut responds 200 and the row holds every sent field', async () => {
    const db = buildDb({
      radioCheckSettings: [{ id: 'rcs-1', tenantId: TENANT, enabled: false, intervalMinutes: 35, perStationTimeoutSeconds: 180 }],
    });
    const req = fakeReq(db, { body: { data: { ...RADIO_SETTINGS_FULL } } });
    const res = fakeRes();
    await radioSettingsPut(req, res);
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    const row = db.radioCheckSettings.rows[0];
    for (const [k, v] of Object.entries(RADIO_SETTINGS_FULL)) {
      assert.deepStrictEqual(row[k], v, `field "${k}" not persisted through the handler`);
    }
  });

  it('radioSettingsPut surfaces a db failure as 5xx, NEVER a fake success', async () => {
    const db = buildDb({ radioCheckSettings: [{ id: 'rcs-1', tenantId: TENANT }] });
    db.radioCheckSettings.rows[0].update = async () => { throw new Error('update failed'); };
    const req = fakeReq(db, { body: { data: { enabled: true } } });
    const res = fakeRes();
    await radioSettingsPut(req, res);
    assert.ok(res.statusCode >= 500, `db failure must not produce a success (got ${res.statusCode})`);
  });

  it('radioEntryEscalate flags the entry (tenant-scoped) and bumps the session incident count', async () => {
    const db = buildDb({
      radioCheckEntry: [{ id: 'ent-1', tenantId: TENANT, sessionId: 'ses-1', classification: 'ok' }],
      radioCheckSession: [{ id: 'ses-1', tenantId: TENANT, incidentCount: 0 }],
    });
    const req = fakeReq(db, { params: { entryId: 'ent-1' } });
    const res = fakeRes();
    await radioEntryEscalate(req, res);

    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    const q = db.radioCheckEntry.calls.findOne[0];
    assert.strictEqual(q.where.tenantId, TENANT);
    assert.strictEqual(db.radioCheckEntry.rows[0].classification, 'incident');
    assert.strictEqual(db.radioCheckSession.rows[0].incidentCount, 1);
  });

  it('radioEntryEscalate on ANOTHER tenant entry returns 404 and writes nothing', async () => {
    const db = buildDb({
      radioCheckEntry: [{ id: 'ent-1', tenantId: OTHER_TENANT, sessionId: 'ses-1', classification: 'ok' }],
    });
    const req = fakeReq(db, { params: { entryId: 'ent-1' } });
    const res = fakeRes();
    await radioEntryEscalate(req, res);
    assert.strictEqual(res.statusCode, 404);
    assert.strictEqual(db.radioCheckEntry.rows[0].classification, 'ok');
  });
});

// ═══════════════════════════ service ════════════════════════════════════════
// Every writable field the CRM "Servicios" form can send.
const SERVICE_FULL = {
  title: 'Guardia armado 24h',
  description: 'Servicio de vigilancia armada',
  price: 1200.5,
  taxName: 'IVA',
  taxRate: 15,
  publishedOnMobile: true,
  iconName: 'patrol',
  importHash: 'hash-svc-1',
};

describe('crud-g15 · serviceRepository.create', () => {
  it('persists EVERY writable field + tenant/user stamps and wires both file relations', async () => {
    const db = buildDb();
    const iconImage = [{ id: 'f-1', name: 'icon.png' }];
    const serviceImages = [{ id: 'f-2', name: 'photo.jpg' }];
    await ServiceRepository.create({ ...SERVICE_FULL, iconImage, serviceImages }, repoOptions(db));

    assert.strictEqual(db.service.calls.create.length, 1);
    const written = db.service.calls.create[0];
    for (const [k, v] of Object.entries(SERVICE_FULL)) {
      assert.deepStrictEqual(written[k], v, `field "${k}" was dropped or altered on create`);
    }
    assert.strictEqual(written.tenantId, TENANT);
    assert.strictEqual(written.createdById, USER_ID);
    assert.strictEqual(written.updatedById, USER_ID);

    const stub = FileRepository.replaceRelationFiles as sinon.SinonStub;
    const cols = stub.getCalls().map((c) => c.args[0].belongsToColumn);
    assert.ok(cols.includes('iconImage'), 'iconImage relation not written');
    assert.ok(cols.includes('serviceImages'), 'serviceImages relation not written');
  });

  it('resolves a valid taxId and snapshots taxName/taxRate from the tax row', async () => {
    const db = buildDb({ tax: [{ id: 'tax-1', name: 'IVA 15', rate: 15 }] });
    await ServiceRepository.create({ ...SERVICE_FULL, taxId: 'tax-1', taxName: undefined, taxRate: undefined }, repoOptions(db));
    const written = db.service.calls.create[0];
    assert.strictEqual(written.taxId, 'tax-1');
    assert.strictEqual(written.taxName, 'IVA 15');
    assert.strictEqual(written.taxRate, 15);
  });

  it('a db failure on create REJECTS (no swallowed error)', async () => {
    const db = buildDb();
    db.service.create = async () => { throw new Error('DB down'); };
    await assert.rejects(() => ServiceRepository.create({ ...SERVICE_FULL }, repoOptions(db)), /DB down/);
  });
});

describe('crud-g15 · serviceRepository.update', () => {
  const seedService = (over: any = {}) => ({ id: 'svc-1', tenantId: TENANT, ...SERVICE_FULL, ...over });

  it('targets the right row (id + tenantId) and applies EVERY changed field', async () => {
    const db = buildDb({ service: [seedService()] });
    const patch = {
      title: 'Guardia armado 12h',
      description: 'Cobertura diurna',
      price: 750,
      taxName: 'IVA 12',
      taxRate: 12,
      publishedOnMobile: false,
      iconName: 'cctv',
      importHash: 'hash-svc-2',
    };
    await ServiceRepository.update('svc-1', patch, repoOptions(db));

    const q = db.service.calls.findOne[0];
    assert.strictEqual(q.where.id, 'svc-1');
    assert.strictEqual(q.where.tenantId, TENANT);

    const applied = db.service.rows[0].__updateCalls[0];
    for (const [k, v] of Object.entries(patch)) {
      assert.deepStrictEqual(applied[k], v, `field "${k}" silently ignored on update`);
    }
    assert.strictEqual(applied.updatedById, USER_ID);
  });

  it('throws Error404 for a service in ANOTHER tenant (no silent cross-tenant write)', async () => {
    const db = buildDb({ service: [seedService({ tenantId: OTHER_TENANT })] });
    await assert.rejects(() => ServiceRepository.update('svc-1', { title: 'x' }, repoOptions(db)), Error404);
    assert.strictEqual(db.service.rows[0].__updateCalls.length, 0);
  });
});

// ═══════════════════════════ additionalService ══════════════════════════════
const ADDITIONAL_SERVICE_FULL = {
  stationAditionalServiceName: 'CCTV Puesto Norte',
  dvr: 'Dvr con disco duro de 1 TB',
  dvrSerialCode: 'DVR-8891',
  juegoDeCamarasInteriores: '4',
  juegoDeCamarasExteriores: '8',
  importHash: 'hash-add-1',
};

describe('crud-g15 · additionalServiceRepository.create', () => {
  it('persists EVERY writable field + maps stations → stationsId + stamps', async () => {
    const db = buildDb();
    await AdditionalServiceRepository.create({ ...ADDITIONAL_SERVICE_FULL, stations: 'st-1' }, repoOptions(db));

    const written = db.additionalService.calls.create[0];
    for (const [k, v] of Object.entries(ADDITIONAL_SERVICE_FULL)) {
      assert.deepStrictEqual(written[k], v, `field "${k}" was dropped or altered on create`);
    }
    assert.strictEqual(written.stationsId, 'st-1', 'stations → stationsId mapping lost');
    assert.strictEqual(written.tenantId, TENANT);
    assert.strictEqual(written.createdById, USER_ID);
    assert.strictEqual(written.updatedById, USER_ID);
  });

  it('a db failure on create REJECTS (no swallowed error)', async () => {
    const db = buildDb();
    db.additionalService.create = async () => { throw new Error('DB down'); };
    await assert.rejects(
      () => AdditionalServiceRepository.create({ ...ADDITIONAL_SERVICE_FULL, stations: 'st-1' }, repoOptions(db)),
      /DB down/,
    );
  });
});

describe('crud-g15 · additionalServiceRepository.update', () => {
  const seedAdd = (over: any = {}) => ({
    id: 'add-1', tenantId: TENANT, ...ADDITIONAL_SERVICE_FULL, stationsId: 'st-1', ...over,
  });

  it('targets id + tenantId and applies EVERY changed field (stations resent)', async () => {
    const db = buildDb({ additionalService: [seedAdd()] });
    const patch = {
      stationAditionalServiceName: 'CCTV renovado',
      dvr: 'Dvr con disco duro de 2 TB',
      dvrSerialCode: 'DVR-9999',
      juegoDeCamarasInteriores: '6',
      juegoDeCamarasExteriores: '10',
      importHash: 'hash-add-2',
    };
    await AdditionalServiceRepository.update('add-1', { ...patch, stations: 'st-2' }, repoOptions(db));

    const q = db.additionalService.calls.findOne[0];
    assert.strictEqual(q.where.id, 'add-1');
    assert.strictEqual(q.where.tenantId, TENANT);

    const applied = db.additionalService.rows[0].__updateCalls[0];
    for (const [k, v] of Object.entries(patch)) {
      assert.deepStrictEqual(applied[k], v, `field "${k}" silently ignored on update`);
    }
    assert.strictEqual(applied.stationsId, 'st-2', 'stations → stationsId mapping lost on update');
    assert.strictEqual(applied.updatedById, USER_ID);
  });

  it('throws Error404 for a row in ANOTHER tenant', async () => {
    const db = buildDb({ additionalService: [seedAdd({ tenantId: OTHER_TENANT })] });
    await assert.rejects(
      () => AdditionalServiceRepository.update('add-1', { dvrSerialCode: 'x' }, repoOptions(db)),
      Error404,
    );
  });

  // FIXED: additionalServiceRepository.update now presence-guards the
  // stations → stationsId mapping (undefined when the patch omits `stations`),
  // so partial updates no longer detach the servicio adicional from its puesto.
  // Create keeps the unconditional mapping as the intended initial value.
  it('a patch WITHOUT `stations` keeps the existing stationsId', async () => {
    const db = buildDb({ additionalService: [seedAdd()] });
    await AdditionalServiceRepository.update('add-1', { dvrSerialCode: 'DVR-0001' }, repoOptions(db));
    assert.strictEqual(
      db.additionalService.rows[0].stationsId,
      'st-1',
      'stationsId was wiped by an update that never mentioned stations',
    );
  });
});

// ═══════════════════════════ bannerSuperiorApp ══════════════════════════════
const BANNER_FULL = {
  title: 'Promo App Móvil',
  description: 'Banner superior de la app',
  link: 'https://cguardpro.com/promo',
  importHash: 'hash-ban-1',
};

describe('crud-g15 · bannerSuperiorAppRepository.create', () => {
  it('persists EVERY writable field + stamps and wires the imageUrl relation', async () => {
    const db = buildDb();
    const imageUrl = [{ id: 'f-1', name: 'banner.png' }];
    await BannerSuperiorAppRepository.create({ ...BANNER_FULL, imageUrl }, repoOptions(db));

    const written = db.bannerSuperiorApp.calls.create[0];
    for (const [k, v] of Object.entries(BANNER_FULL)) {
      assert.deepStrictEqual(written[k], v, `field "${k}" was dropped or altered on create`);
    }
    assert.strictEqual(written.tenantId, TENANT);
    assert.strictEqual(written.createdById, USER_ID);

    const stub = FileRepository.replaceRelationFiles as sinon.SinonStub;
    assert.ok(stub.callCount >= 1, 'imageUrl relation not written');
    assert.strictEqual(stub.firstCall.args[0].belongsToColumn, 'imageUrl');
    assert.deepStrictEqual(stub.firstCall.args[1], imageUrl);
  });

  it('a db failure on create REJECTS (no swallowed error)', async () => {
    const db = buildDb();
    db.bannerSuperiorApp.create = async () => { throw new Error('DB down'); };
    await assert.rejects(() => BannerSuperiorAppRepository.create({ ...BANNER_FULL }, repoOptions(db)), /DB down/);
  });
});

describe('crud-g15 · bannerSuperiorAppRepository.update', () => {
  it('targets id + tenantId and applies EVERY changed field', async () => {
    const db = buildDb({ bannerSuperiorApp: [{ id: 'ban-1', tenantId: TENANT, ...BANNER_FULL }] });
    const patch = {
      title: 'Promo actualizada',
      description: 'nuevo texto',
      link: 'https://cguardpro.com/promo2',
      importHash: 'hash-ban-2',
    };
    await BannerSuperiorAppRepository.update('ban-1', patch, repoOptions(db));

    const q = db.bannerSuperiorApp.calls.findOne[0];
    assert.strictEqual(q.where.id, 'ban-1');
    assert.strictEqual(q.where.tenantId, TENANT);

    const applied = db.bannerSuperiorApp.rows[0].__updateCalls[0];
    for (const [k, v] of Object.entries(patch)) {
      assert.deepStrictEqual(applied[k], v, `field "${k}" silently ignored on update`);
    }
    assert.strictEqual(applied.updatedById, USER_ID);
  });

  it('throws Error404 for a banner in ANOTHER tenant', async () => {
    const db = buildDb({ bannerSuperiorApp: [{ id: 'ban-1', tenantId: OTHER_TENANT, ...BANNER_FULL }] });
    await assert.rejects(() => BannerSuperiorAppRepository.update('ban-1', { title: 'x' }, repoOptions(db)), Error404);
    assert.strictEqual(db.bannerSuperiorApp.rows[0].__updateCalls.length, 0);
  });
});

// ═══════════════════════════ deviceIdInformation ════════════════════════════
// The documented CRM surface for this module writes deviceId + importHash (the
// push/telemetry columns are written by the device-registration path, not here).
const DEVICE_ID_FULL = { deviceId: 'android-3f9c-1122', importHash: 'hash-dev-1' };

describe('crud-g15 · deviceIdInformationRepository create/update', () => {
  it('create persists the writable fields + tenant/user stamps', async () => {
    const db = buildDb();
    await DeviceIdInformationRepository.create({ ...DEVICE_ID_FULL }, repoOptions(db));
    const written = db.deviceIdInformation.calls.create[0];
    for (const [k, v] of Object.entries(DEVICE_ID_FULL)) {
      assert.deepStrictEqual(written[k], v, `field "${k}" was dropped or altered on create`);
    }
    assert.strictEqual(written.tenantId, TENANT);
    assert.strictEqual(written.createdById, USER_ID);
    assert.strictEqual(written.updatedById, USER_ID);
  });

  it('update targets id + tenantId and applies the patch', async () => {
    const db = buildDb({ deviceIdInformation: [{ id: 'dev-1', tenantId: TENANT, ...DEVICE_ID_FULL }] });
    await DeviceIdInformationRepository.update('dev-1', { deviceId: 'ios-77aa', importHash: 'hash-dev-2' }, repoOptions(db));

    const q = db.deviceIdInformation.calls.findOne[0];
    assert.strictEqual(q.where.id, 'dev-1');
    assert.strictEqual(q.where.tenantId, TENANT);

    const applied = db.deviceIdInformation.rows[0].__updateCalls[0];
    assert.strictEqual(applied.deviceId, 'ios-77aa');
    assert.strictEqual(applied.importHash, 'hash-dev-2');
    assert.strictEqual(applied.updatedById, USER_ID);
  });

  it('throws Error404 for a device row in ANOTHER tenant', async () => {
    const db = buildDb({ deviceIdInformation: [{ id: 'dev-1', tenantId: OTHER_TENANT, ...DEVICE_ID_FULL }] });
    await assert.rejects(
      () => DeviceIdInformationRepository.update('dev-1', { deviceId: 'x' }, repoOptions(db)),
      Error404,
    );
  });

  it('service.create rolls back the transaction and REJECTS when the db write fails', async () => {
    const db = buildDb();
    db.deviceIdInformation.create = async () => { throw new Error('insert failed'); };
    const svc = new DeviceIdInformationService(repoOptions(db));
    await assert.rejects(() => svc.create({ ...DEVICE_ID_FULL }), /insert failed/);
    assert.strictEqual(db.sequelize.__rollbacks, 1);
    assert.strictEqual(db.sequelize.__commits, 0);
  });
});

// ═══════════════════════════ supervisor (worker app) ════════════════════════
describe('crud-g15 · supervisor POST /me/location', () => {
  it('updates ONLY the caller\'s tenant-scoped profile position and appends a full breadcrumb', async () => {
    const db = buildDb({
      supervisorProfile: [{ id: 'prof-1', tenantId: TENANT, supervisorUserId: USER_ID, latitude: 0, longitude: 0 }],
    });
    const req = fakeReq(db, {
      body: { data: { latitude: -0.1807, longitude: -78.4678, speed: 12.5, heading: 270, accuracy: 8, recordedAt: '2026-07-15T09:30:00.000Z' } },
    });
    const res = fakeRes();
    await updateMyLocation(req, res);

    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.deepStrictEqual(res.body, { ok: true });

    // static UPDATE targets the caller's row within the tenant
    const call = db.supervisorProfile.calls.update[0];
    assert.strictEqual(call.where.tenantId, TENANT);
    assert.strictEqual(call.where.supervisorUserId, USER_ID);
    assert.strictEqual(call.values.latitude, -0.1807);
    assert.strictEqual(call.values.longitude, -78.4678);

    // immutable breadcrumb keeps every telemetry field
    const ping = db.locationPing.calls.create[0];
    assert.strictEqual(ping.tenantId, TENANT);
    assert.strictEqual(ping.subjectType, 'supervisor');
    assert.strictEqual(ping.userId, USER_ID);
    assert.strictEqual(ping.latitude, -0.1807);
    assert.strictEqual(ping.longitude, -78.4678);
    assert.strictEqual(ping.speed, 12.5);
    assert.strictEqual(ping.heading, 270);
    assert.strictEqual(ping.accuracy, 8);
    assert.strictEqual(new Date(ping.recordedAt).toISOString(), '2026-07-15T09:30:00.000Z');
  });

  it('a ping without coordinates writes NOTHING and answers ok:false', async () => {
    const db = buildDb({
      supervisorProfile: [{ id: 'prof-1', tenantId: TENANT, supervisorUserId: USER_ID }],
    });
    const req = fakeReq(db, { body: { data: { speed: 3 } } });
    const res = fakeRes();
    await updateMyLocation(req, res);
    assert.deepStrictEqual(res.body, { ok: false });
    assert.strictEqual(db.supervisorProfile.calls.update.length, 0);
    assert.strictEqual(db.locationPing.calls.create.length, 0);
  });
});
