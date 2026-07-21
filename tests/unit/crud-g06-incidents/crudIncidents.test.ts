/**
 * Unit tests — CRUD persistence fidelity for the g06-incidents group.
 *
 * Context: tenants report "things are not being saved". The classic causes are
 * (1) a handler accepts a field but the repository DROPS it before the write,
 * (2) update paths whose where-clause / whitelist silently ignores changes,
 * (3) swallowed errors (try/catch returning success anyway).
 *
 * Covered (REAL repository/service/handler code against a Sequelize-shaped
 * fake db — no MySQL, no network):
 *   - IncidentRepository create/update         (field fidelity, alias mapping,
 *                                               presence-guarded FKs, where
 *                                               target, error propagation)
 *   - IncidentService create/update            (FK alias resolution; documents
 *                                               the partial-update FK-wipe bug)
 *   - IncidentTypeRepository create/update/destroy (incl. in-use guard)
 *   - KpiRepository create/update              (documents the partial-update
 *                                               guardId/postSiteId clobber bug)
 *   - alarm panel/contact/zone handlers        (full express handlers: field
 *                                               fidelity, secret handling,
 *                                               tenant scoping, 500-not-success)
 *   - alarm caseAcknowledge/caseResolve        (state transition + audit row)
 *   - logSecurityEvent (securityAuditLog)      (field fidelity + truncation)
 *
 * Run:
 *   cross-env NODE_ENV=test TS_NODE_PROJECT=tsconfig.test.json \
 *     npx mocha -r ts-node/register \
 *     'tests/unit/crud-g06-incidents/**\/*.test.ts' --exit --timeout 20000
 */

import assert from 'assert';
import sinon from 'sinon';
import Sequelize from 'sequelize';

import IncidentRepository from '../../../src/database/repositories/incidentRepository';
import IncidentTypeRepository from '../../../src/database/repositories/incidentTypeRepository';
import KpiRepository from '../../../src/database/repositories/kpiRepository';
import IncidentService from '../../../src/services/incidentService';
import AuditLogRepository from '../../../src/database/repositories/auditLogRepository';
import FileRepository from '../../../src/database/repositories/fileRepository';
import Error400 from '../../../src/errors/Error400';
import Error404 from '../../../src/errors/Error404';
import { logSecurityEvent } from '../../../src/services/auth/securityAudit';

import alarmPanelCreate from '../../../src/api/alarm/panelCreate';
import alarmPanelUpdate from '../../../src/api/alarm/panelUpdate';
import alarmContactCreate from '../../../src/api/alarm/contactCreate';
import alarmContactUpdate from '../../../src/api/alarm/contactUpdate';
import alarmZoneCreate from '../../../src/api/alarm/zoneCreate';
import alarmZoneUpdate from '../../../src/api/alarm/zoneUpdate';
import alarmCaseAcknowledge from '../../../src/api/alarm/caseAcknowledge';
import alarmCaseResolve from '../../../src/api/alarm/caseResolve';

const Op = Sequelize.Op;

const TENANT = 'tenant-A';
const OTHER_TENANT = 'tenant-B';
const USER_ID = 'user-1';

// ──────────────────────── makeRow / fake db (Sequelize-shaped) ───────────────
function makeRow(data: any) {
  const row: any = {
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
    // Association getters used by incident._fillWithRelationsAndFiles.
    async getImageUrl() {
      return null;
    },
    async getIncidentType() {
      return null;
    },
    async getClient() {
      return null;
    },
    async getSite() {
      return null;
    },
    async getStation() {
      return null;
    },
    async getGuardName() {
      return null;
    },
  };
  return row;
}

/** Where matcher supporting plain equality + Op.ne / Op.in / Op.and. */
function matchWhere(row: any, where: any): boolean {
  if (!where) return true;
  for (const key of Reflect.ownKeys(where)) {
    const cond = (where as any)[key];
    if (key === Op.and) {
      const parts = Array.isArray(cond) ? cond : [cond];
      if (!parts.every((p) => matchWhere(row, p))) return false;
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
    calls: { create: [] as any[], findOne: [] as any[], findAll: [] as any[], destroy: [] as any[] },
    getTableName: () => `${name}s`,
    async create(data: any) {
      model.calls.create.push({ ...data });
      const row = makeRow({ id: data.id || `${name}-${model.rows.length + 1}`, ...data, deletedAt: null });
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
    async findAndCountAll(q: any = {}) {
      const rows = model.rows.filter((r: any) => !r.__destroyed && matchWhere(r, q.where));
      return { rows, count: rows.length };
    },
    async count() {
      return 0;
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

function buildDb(seed: {
  incidents?: any[];
  incidentTypes?: any[];
  kpis?: any[];
  stations?: any[];
  clientAccounts?: any[];
  businessInfos?: any[];
  securityGuards?: any[];
  alarmPanels?: any[];
  alarmContacts?: any[];
  alarmZones?: any[];
  alarmCases?: any[];
  alarmAuditLogs?: any[];
  securityAuditLogs?: any[];
  inUseCount?: number;
} = {}) {
  return {
    incident: makeModel('incident', seed.incidents || []),
    incidentType: makeModel('incidentType', seed.incidentTypes || []),
    kpi: makeModel('kpi', seed.kpis || []),
    station: makeModel('station', seed.stations || []),
    clientAccount: makeModel('clientAccount', seed.clientAccounts || []),
    businessInfo: makeModel('businessInfo', seed.businessInfos || []),
    securityGuard: makeModel('securityGuard', seed.securityGuards || []),
    tenantUser: makeModel('tenantUser', []),
    user: makeModel('user', []),
    file: makeModel('file', []),
    report: makeModel('report', []),
    alarmPanel: makeModel('alarmPanel', seed.alarmPanels || []),
    alarmContact: makeModel('alarmContact', seed.alarmContacts || []),
    alarmZone: makeModel('alarmZone', seed.alarmZones || []),
    alarmCase: makeModel('alarmCase', seed.alarmCases || []),
    alarmAuditLog: makeModel('alarmAuditLog', seed.alarmAuditLogs || []),
    securityAuditLog: makeModel('securityAuditLog', seed.securityAuditLogs || []),
    sequelize: {
      // Used by IncidentService/KpiService transactions.
      transaction: async () => ({ commit: async () => {}, rollback: async () => {} }),
      // Used by IncidentTypeRepository.destroy in-use check.
      query: async () => [[{ count: seed.inUseCount || 0 }]],
    },
  } as any;
}

// Admin currentUser: passes both the incident repo's admin visibility check
// and PermissionChecker (free plan; shadow gates off in test).
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
    headers: {},
    ...extra,
  } as any;
}

function fakeRes() {
  const res: any = { statusCode: 200, body: undefined };
  res.status = (c: number) => {
    res.statusCode = c;
    return res;
  };
  res.json = (b: any) => {
    res.body = b;
    return res;
  };
  res.send = (b: any) => {
    res.body = b;
    return res;
  };
  res.sendStatus = (c: number) => {
    res.statusCode = c;
    return res;
  };
  res.header = () => res;
  return res;
}

// Stub cross-cutting side channels (audit log + file relations) — not the
// persistence under test.
describe('crudIncidents (full-suite scope)', () => {
beforeEach(() => {
  if ((AuditLogRepository as any).log?.restore) (AuditLogRepository as any).log.restore();
  sinon.stub(AuditLogRepository, 'log').resolves();
  if ((FileRepository as any).replaceRelationFiles?.restore) (FileRepository as any).replaceRelationFiles.restore();
  sinon.stub(FileRepository, 'replaceRelationFiles').resolves();
  if ((FileRepository as any).fillDownloadUrl?.restore) (FileRepository as any).fillDownloadUrl.restore();
  sinon.stub(FileRepository, 'fillDownloadUrl').resolves(null as any);
});
afterEach(() => sinon.restore());

// ═══════════════════════════ incident (repository) ═══════════════════════════
describe('crud-g06 · IncidentRepository.create', () => {
  // Every whitelisted scalar the CRM/worker incident form can send.
  const FULL_CREATE = {
    date: '2026-07-14T10:00:00Z',
    dateTime: '2026-07-14T10:05:00Z',
    incidentAt: '2026-07-14T09:55:00Z',
    title: 'Intrusión perimetral',
    subject: 'Intrusión',
    description: 'Persona no autorizada saltó la cerca norte',
    content: 'Detalle completo del evento',
    action: 'Se notificó al supervisor',
    callerName: 'Juan Cliente',
    callerType: 'client',
    status: 'abierto',
    workStatus: 'inProgress',
    dispatchStatus: 'dispatched',
    dispatchedAt: '2026-07-14T10:10:00Z',
    priority: 'alta',
    internalNotes: 'Revisar cámaras 3 y 4',
    actionsTaken: 'Ronda extra ordenada',
    location: 'Cerca norte',
    comments: [{ by: 'ops', text: 'seguimiento' }],
    wasRead: true,
    importHash: 'inc-hash-1',
  };
  const FKS = {
    stationId: 'st-1',
    postSiteId: 'ps-1',
    clientId: 'ca-1',
    guardNameId: 'sg-1',
  };

  it('persists EVERY writable field the form sends (field fidelity)', async () => {
    const db = buildDb();
    await IncidentRepository.create(
      { ...FULL_CREATE, ...FKS, incidentType: 'it-1' },
      repoOptions(db),
    );

    assert.strictEqual(db.incident.calls.create.length, 1);
    const written = db.incident.calls.create[0];
    for (const [k, v] of Object.entries(FULL_CREATE)) {
      assert.deepStrictEqual(written[k], v, `field "${k}" was dropped or altered on create`);
    }
    assert.strictEqual(written.stationId, 'st-1');
    assert.strictEqual(written.postSiteId, 'ps-1');
    assert.strictEqual(written.clientId, 'ca-1');
    assert.strictEqual(written.guardNameId, 'sg-1');
    assert.strictEqual(written.incidentTypeId, 'it-1', 'incidentType not mapped to incidentTypeId');
    assert.strictEqual(written.tenantId, TENANT);
    assert.strictEqual(written.createdById, USER_ID);
    assert.strictEqual(written.updatedById, USER_ID);
  });

  it('maps the frontend aliases (stationIncidents→stationId, siteId→postSiteId)', async () => {
    const db = buildDb();
    await IncidentRepository.create(
      { ...FULL_CREATE, stationIncidents: 'st-9', siteId: 'ps-9', postSiteId: undefined },
      repoOptions(db),
    );
    const written = db.incident.calls.create[0];
    assert.strictEqual(written.stationId, 'st-9');
    assert.strictEqual(written.postSiteId, 'ps-9');
  });

  it('stores the evidence photos via the imageUrl file relation', async () => {
    const db = buildDb();
    const photos = [{ id: 'f-1', name: 'evidencia.jpg' }];
    await IncidentRepository.create({ ...FULL_CREATE, imageUrl: photos }, repoOptions(db));
    const stub = FileRepository.replaceRelationFiles as sinon.SinonStub;
    const call = stub.getCalls().find((c) => c.args[0].belongsToColumn === 'imageUrl');
    assert.ok(call, 'imageUrl relation not written');
    assert.deepStrictEqual(call!.args[1], photos);
  });

  it('a db failure on create PROPAGATES (not swallowed into a success)', async () => {
    const db = buildDb();
    db.incident.create = async () => {
      throw new Error('DB down');
    };
    await assert.rejects(
      () => IncidentRepository.create({ ...FULL_CREATE }, repoOptions(db)),
      /DB down/,
    );
  });
});

describe('crud-g06 · IncidentRepository.update', () => {
  const EXISTING = {
    id: 'inc-1',
    tenantId: TENANT,
    date: '2026-07-01T08:00:00Z',
    title: 'Viejo título',
    description: 'Vieja descripción',
    status: 'abierto',
    workStatus: 'open',
    priority: 'media',
    stationId: 'st-1',
    postSiteId: 'ps-1',
    clientId: 'ca-1',
    guardNameId: 'sg-1',
    incidentTypeId: 'it-1',
    wasRead: false,
    deletedAt: null,
  };

  const FULL_UPDATE = {
    date: '2026-07-14T10:00:00Z',
    dateTime: '2026-07-14T10:05:00Z',
    incidentAt: '2026-07-14T09:55:00Z',
    title: 'Título editado',
    subject: 'Asunto editado',
    description: 'Descripción editada',
    content: 'Contenido editado',
    action: 'Acción editada',
    callerName: 'María',
    callerType: 'guard',
    status: 'cerrado',
    workStatus: 'resolved',
    dispatchStatus: 'onScene',
    dispatchedAt: '2026-07-14T10:20:00Z',
    priority: 'baja',
    internalNotes: 'nota interna nueva',
    actionsTaken: 'acciones nuevas',
    location: 'Puerta sur',
    comments: [{ by: 'ops', text: 'cerrado ok' }],
    wasRead: true,
    importHash: 'inc-hash-2',
  };

  it('applies EVERY writable field onto the right row (id + tenantId in the where)', async () => {
    const db = buildDb({ incidents: [{ ...EXISTING }] });
    await IncidentRepository.update(
      'inc-1',
      { ...FULL_UPDATE, stationId: 'st-2', incidentTypeId: 'it-2', postSiteId: 'ps-2', clientId: 'ca-2', guardNameId: 'sg-2' },
      repoOptions(db),
    );

    const firstFind = db.incident.calls.findOne[0];
    assert.strictEqual(firstFind.where.id, 'inc-1');
    assert.strictEqual(firstFind.where.tenantId, TENANT);

    const row = db.incident.rows[0];
    assert.ok(row.__updateCalls.length >= 1, 'row.update was never called');
    const patch = row.__updateCalls[0];
    for (const [k, v] of Object.entries(FULL_UPDATE)) {
      assert.deepStrictEqual(patch[k], v, `field "${k}" was dropped or altered on update`);
    }
    assert.strictEqual(patch.stationId, 'st-2');
    assert.strictEqual(patch.incidentTypeId, 'it-2');
    assert.strictEqual(patch.postSiteId, 'ps-2');
    assert.strictEqual(patch.clientId, 'ca-2');
    assert.strictEqual(patch.guardNameId, 'sg-2');
    assert.strictEqual(patch.updatedById, USER_ID);
    assert.strictEqual(row.status, 'cerrado');
    assert.strictEqual(row.workStatus, 'resolved');
  });

  it('a partial patch (repo level) keeps the FK links — the presence guard works', async () => {
    const db = buildDb({ incidents: [{ ...EXISTING }] });
    await IncidentRepository.update('inc-1', { status: 'cerrado' }, repoOptions(db));
    const row = db.incident.rows[0];
    assert.strictEqual(row.status, 'cerrado');
    assert.strictEqual(row.stationId, 'st-1', 'stationId wiped by partial update');
    assert.strictEqual(row.postSiteId, 'ps-1', 'postSiteId wiped by partial update');
    assert.strictEqual(row.clientId, 'ca-1', 'clientId wiped by partial update');
    assert.strictEqual(row.guardNameId, 'sg-1', 'guardNameId wiped by partial update');
    assert.strictEqual(row.incidentTypeId, 'it-1', 'incidentTypeId wiped by partial update');
  });

  it('throws Error404 (and writes nothing) when the id belongs to another tenant', async () => {
    const db = buildDb({ incidents: [{ ...EXISTING, tenantId: OTHER_TENANT }] });
    await assert.rejects(
      () => IncidentRepository.update('inc-1', { ...FULL_UPDATE }, repoOptions(db)),
      (e: any) => e instanceof Error404,
    );
    assert.strictEqual(db.incident.rows[0].__updateCalls.length, 0);
  });

  it('a db failure on row.update PROPAGATES (not swallowed)', async () => {
    const db = buildDb({ incidents: [{ ...EXISTING }] });
    db.incident.rows[0].update = async () => {
      throw new Error('write failed');
    };
    await assert.rejects(
      () => IncidentRepository.update('inc-1', { ...FULL_UPDATE }, repoOptions(db)),
      /write failed/,
    );
  });
});

// ═══════════════════════════ incident (service) ══════════════════════════════
describe('crud-g06 · IncidentService (the layer the API handlers call)', () => {
  const seedRelations = {
    stations: [{ id: 'st-1', tenantId: TENANT, stationName: 'Puesto 1', deletedAt: null }],
    incidentTypes: [{ id: 'it-1', tenantId: TENANT, name: 'Robo', deletedAt: null }],
    businessInfos: [{ id: 'ps-1', tenantId: TENANT, companyName: 'Sitio 1', deletedAt: null }],
    clientAccounts: [{ id: 'ca-1', tenantId: TENANT, name: 'Cliente 1', deletedAt: null }],
    securityGuards: [{ id: 'sg-1', tenantId: TENANT, fullName: 'Vigilante 1', deletedAt: null }],
  };

  it('create resolves the FK aliases against the tenant and persists them', async () => {
    const db = buildDb(seedRelations);
    const service = new IncidentService(repoOptions(db));
    await service.create({
      title: 'Novedad',
      description: 'Detalle',
      date: '2026-07-14T10:00:00Z',
      incidentTypeId: 'it-1', // alias: incidentTypeId → incidentType
      guardId: 'sg-1', // alias: guardId → guardNameId
      postSite: 'ps-1', // alias: postSite → postSiteId
      stationId: 'st-1',
      clientId: 'ca-1',
      priority: 'baja',
    });

    assert.strictEqual(db.incident.calls.create.length, 1);
    const written = db.incident.calls.create[0];
    assert.strictEqual(written.incidentTypeId, 'it-1');
    assert.strictEqual(written.guardNameId, 'sg-1');
    assert.strictEqual(written.postSiteId, 'ps-1');
    assert.strictEqual(written.stationId, 'st-1');
    assert.strictEqual(written.clientId, 'ca-1');
    assert.strictEqual(written.tenantId, TENANT);
  });

  it("create refuses another tenant's FK ids (filtered to null, not written)", async () => {
    const db = buildDb({
      ...seedRelations,
      securityGuards: [{ id: 'sg-x', tenantId: OTHER_TENANT, fullName: 'Ajeno', deletedAt: null }],
    });
    const service = new IncidentService(repoOptions(db));
    await service.create({
      title: 'Novedad',
      description: 'Detalle',
      date: '2026-07-14T10:00:00Z',
      guardNameId: 'sg-x',
    });
    const written = db.incident.calls.create[0];
    assert.strictEqual(written.guardNameId, null, "another tenant's guard id must not persist");
  });

  it('a db failure inside create ROLLS BACK and propagates (not swallowed)', async () => {
    const db = buildDb(seedRelations);
    let rolledBack = false;
    db.sequelize.transaction = async () => ({
      commit: async () => {},
      rollback: async () => {
        rolledBack = true;
      },
    });
    db.incident.create = async () => {
      throw new Error('insert exploded');
    };
    const service = new IncidentService(repoOptions(db));
    await assert.rejects(
      () =>
        service.create({ title: 'X', description: 'Y', date: '2026-07-14T10:00:00Z' }),
      /insert exploded/,
    );
    assert.strictEqual(rolledBack, true, 'transaction must be rolled back');
  });

  // FIXED: IncidentService.update now presence-guards the FK alias
  // normalization and the filterIdInTenant calls, so keys the caller did not
  // send stay undefined and IncidentRepository.update's presence guard
  // (incidentRepository.ts:143-158) keeps the FK links intact.
  it('update with ONLY {status} must keep the incident FK links (service level)', async () => {
    const db = buildDb({
      ...seedRelations,
      incidents: [
        {
          id: 'inc-1',
          tenantId: TENANT,
          date: '2026-07-01T08:00:00Z',
          title: 'T',
          description: 'D',
          status: 'abierto',
          stationId: 'st-1',
          postSiteId: 'ps-1',
          clientId: 'ca-1',
          guardNameId: 'sg-1',
          incidentTypeId: 'it-1',
          deletedAt: null,
        },
      ],
    });
    const service = new IncidentService(repoOptions(db));
    await service.update('inc-1', { status: 'cerrado' });
    const row = db.incident.rows[0];
    assert.strictEqual(row.status, 'cerrado');
    assert.strictEqual(row.stationId, 'st-1', 'stationId wiped by service-level partial update');
    assert.strictEqual(row.postSiteId, 'ps-1', 'postSiteId wiped by service-level partial update');
    assert.strictEqual(row.clientId, 'ca-1', 'clientId wiped by service-level partial update');
    assert.strictEqual(row.guardNameId, 'sg-1', 'guardNameId wiped by service-level partial update');
    assert.strictEqual(row.incidentTypeId, 'it-1', 'incidentTypeId wiped by service-level partial update');
  });

  it('update that re-sends all FKs persists them (the full-form path works)', async () => {
    const db = buildDb({
      ...seedRelations,
      incidents: [
        {
          id: 'inc-1',
          tenantId: TENANT,
          date: '2026-07-01T08:00:00Z',
          title: 'T',
          description: 'D',
          status: 'abierto',
          stationId: 'st-1',
          postSiteId: 'ps-1',
          clientId: 'ca-1',
          guardNameId: 'sg-1',
          incidentTypeId: 'it-1',
          deletedAt: null,
        },
      ],
    });
    const service = new IncidentService(repoOptions(db));
    await service.update('inc-1', {
      title: 'Editado',
      status: 'cerrado',
      stationId: 'st-1',
      postSiteId: 'ps-1',
      clientId: 'ca-1',
      guardNameId: 'sg-1',
      incidentType: 'it-1',
    });
    const row = db.incident.rows[0];
    assert.strictEqual(row.title, 'Editado');
    assert.strictEqual(row.status, 'cerrado');
    assert.strictEqual(row.stationId, 'st-1');
    assert.strictEqual(row.guardNameId, 'sg-1');
    assert.strictEqual(row.incidentTypeId, 'it-1');
  });
});

// ═══════════════════════════ incidentType ════════════════════════════════════
describe('crud-g06 · IncidentTypeRepository', () => {
  const FULL_TYPE = { name: 'Robo a mano armada', active: true, importHash: 'it-hash' };

  it('create persists every field (name, active, importHash) with tenant + audit ids', async () => {
    const db = buildDb();
    await IncidentTypeRepository.create({ ...FULL_TYPE }, repoOptions(db));
    assert.strictEqual(db.incidentType.calls.create.length, 1);
    const written = db.incidentType.calls.create[0];
    for (const [k, v] of Object.entries(FULL_TYPE)) {
      assert.deepStrictEqual(written[k], v, `field "${k}" was dropped or altered on create`);
    }
    assert.strictEqual(written.tenantId, TENANT);
    assert.strictEqual(written.createdById, USER_ID);
    assert.strictEqual(written.updatedById, USER_ID);
  });

  it('update targets {id, tenantId} and applies the patch (rename + deactivate)', async () => {
    const db = buildDb({
      incidentTypes: [{ id: 'it-1', tenantId: TENANT, name: 'Viejo', active: true, deletedAt: null }],
    });
    await IncidentTypeRepository.update(
      'it-1',
      { name: 'Nuevo Nombre', active: false, importHash: 'h2' },
      repoOptions(db),
    );
    const firstFind = db.incidentType.calls.findOne[0];
    assert.strictEqual(firstFind.where.id, 'it-1');
    assert.strictEqual(firstFind.where.tenantId, TENANT);

    const row = db.incidentType.rows[0];
    const patch = row.__updateCalls[0];
    assert.strictEqual(patch.name, 'Nuevo Nombre');
    assert.strictEqual(patch.active, false);
    assert.strictEqual(patch.importHash, 'h2');
    assert.strictEqual(patch.updatedById, USER_ID);
    assert.strictEqual(row.active, false);
  });

  it('update on a foreign-tenant type throws Error404 and writes nothing', async () => {
    const db = buildDb({
      incidentTypes: [{ id: 'it-1', tenantId: OTHER_TENANT, name: 'Ajeno', active: true, deletedAt: null }],
    });
    await assert.rejects(
      () => IncidentTypeRepository.update('it-1', { name: 'X' }, repoOptions(db)),
      (e: any) => e instanceof Error404,
    );
    assert.strictEqual(db.incidentType.rows[0].__updateCalls.length, 0);
  });

  it('destroy is blocked with Error400 while incidents still use the type', async () => {
    const db = buildDb({
      incidentTypes: [{ id: 'it-1', tenantId: TENANT, name: 'Robo', active: true, deletedAt: null }],
      inUseCount: 3,
    });
    await assert.rejects(
      () => IncidentTypeRepository.destroy('it-1', repoOptions(db)),
      (e: any) => e instanceof Error400,
    );
    assert.strictEqual(db.incidentType.rows[0].__destroyed, false, 'type must not be deleted while in use');
  });

  it('destroy removes an unused type (tenant-scoped lookup)', async () => {
    const db = buildDb({
      incidentTypes: [{ id: 'it-1', tenantId: TENANT, name: 'Sin uso', active: true, deletedAt: null }],
      inUseCount: 0,
    });
    await IncidentTypeRepository.destroy('it-1', repoOptions(db));
    assert.strictEqual(db.incidentType.rows[0].__destroyed, true);
    const firstFind = db.incidentType.calls.findOne[0];
    assert.strictEqual(firstFind.where.tenantId, TENANT);
  });
});

// ═══════════════════════════════ kpi ═════════════════════════════════════════
describe('crud-g06 · KpiRepository', () => {
  // Every writable field the CRM KPI form can send (repo whitelist + model).
  const FULL_KPI = {
    scope: 'guard',
    frequency: 'monthly',
    description: 'KPI de reportes mensuales',
    reportOptions: { includePhotos: true },
    emailNotification: true,
    emails: ['ops@tenant.ec'],
    active: true,
    importHash: 'kpi-hash',
    standardReports: true,
    standardReportsNumber: 10,
    incidentReports: true,
    incidentReportsNumber: 5,
    routeReports: true,
    routeReportsNumber: 8,
    taskReports: true,
    taskReportsNumber: 4,
    verificationReports: true,
    verificationReportsNumber: 6,
  };

  it('create persists EVERY writable field + the guard/postSite aliases', async () => {
    const db = buildDb();
    await KpiRepository.create({ ...FULL_KPI, guard: 'sg-1', postSite: 'ps-1' }, repoOptions(db));
    assert.strictEqual(db.kpi.calls.create.length, 1);
    const written = db.kpi.calls.create[0];
    for (const [k, v] of Object.entries(FULL_KPI)) {
      assert.deepStrictEqual(written[k], v, `field "${k}" was dropped or altered on create`);
    }
    assert.strictEqual(written.guardId, 'sg-1', 'guard alias not mapped to guardId');
    assert.strictEqual(written.postSiteId, 'ps-1', 'postSite alias not mapped to postSiteId');
    assert.strictEqual(written.tenantId, TENANT);
    assert.strictEqual(written.createdById, USER_ID);
    assert.strictEqual(written.updatedById, USER_ID);
  });

  it('update targets {id, tenantId} and applies the full patch', async () => {
    const db = buildDb({
      kpis: [{ id: 'kpi-1', tenantId: TENANT, scope: 'guard', guardId: 'sg-1', postSiteId: 'ps-1', active: true, deletedAt: null }],
    });
    const patch = { ...FULL_KPI, scope: 'postSite', description: 'Editado', active: false };
    await KpiRepository.update('kpi-1', { ...patch, guardId: 'sg-2', postSiteId: 'ps-2' }, repoOptions(db));

    const firstFind = db.kpi.calls.findOne[0];
    assert.strictEqual(firstFind.where.id, 'kpi-1');
    assert.strictEqual(firstFind.where.tenantId, TENANT);

    const row = db.kpi.rows[0];
    const written = row.__updateCalls[0];
    for (const [k, v] of Object.entries(patch)) {
      assert.deepStrictEqual(written[k], v, `field "${k}" was dropped or altered on update`);
    }
    assert.strictEqual(written.guardId, 'sg-2');
    assert.strictEqual(written.postSiteId, 'ps-2');
    assert.strictEqual(written.updatedById, USER_ID);
    assert.strictEqual(row.active, false);
  });

  // FIXED: KpiRepository.update now presence-guards guardId/postSiteId
  // (writes undefined when neither the field nor its alias was sent), so
  // partial updates no longer detach the KPI from its guard/site.
  it('a partial update must NOT clobber guardId/postSiteId', async () => {
    const db = buildDb({
      kpis: [{ id: 'kpi-1', tenantId: TENANT, scope: 'guard', guardId: 'sg-1', postSiteId: 'ps-1', active: true, deletedAt: null }],
    });
    await KpiRepository.update('kpi-1', { active: false }, repoOptions(db));
    const row = db.kpi.rows[0];
    assert.strictEqual(row.guardId, 'sg-1', 'guardId wiped by partial update');
    assert.strictEqual(row.postSiteId, 'ps-1', 'postSiteId wiped by partial update');
  });

  it('update on a foreign-tenant KPI throws Error404 and writes nothing', async () => {
    const db = buildDb({
      kpis: [{ id: 'kpi-1', tenantId: OTHER_TENANT, scope: 'guard', active: true, deletedAt: null }],
    });
    await assert.rejects(
      () => KpiRepository.update('kpi-1', { active: false }, repoOptions(db)),
      (e: any) => e instanceof Error404,
    );
    assert.strictEqual(db.kpi.rows[0].__updateCalls.length, 0);
  });

  it('a db failure on create PROPAGATES (not swallowed)', async () => {
    const db = buildDb();
    db.kpi.create = async () => {
      throw new Error('kpi insert failed');
    };
    await assert.rejects(
      () => KpiRepository.create({ ...FULL_KPI }, repoOptions(db)),
      /kpi insert failed/,
    );
  });
});

// ═══════════════════════════ alarm · panel ═══════════════════════════════════
describe('crud-g06 · alarm panelCreate/panelUpdate handlers', () => {
  const FULL_PANEL_BODY = {
    name: 'Panel Bodega Norte',
    accountNumber: 'ACCT-042',
    protocol: 'sia-dc09',
    panelType: 'intrusion',
    make: 'DSC',
    model: 'NEO-2128',
    comms: 'ip',
    receiverLine: 'L1',
    psapAgency: 'ECU-911',
    psapPhone: '911',
    asapOri: 'ORI-77',
    dc09Key: 'super-secret-aes-key',
    supervisionMins: '15',
    testIntervalHrs: '24',
    status: 'online',
    lastSignalAt: '2026-07-14T10:00:00Z',
    postSiteId: 'ps-1',
    stationId: 'st-1',
    customerId: 'ca-1',
    notes: 'Instalado en rack 2',
    active: true,
  };

  it('create persists EVERY field (numbers coerced) with tenant + audit ids', async () => {
    const db = buildDb();
    const req = fakeReq(db, { params: { tenantId: TENANT }, body: { ...FULL_PANEL_BODY } });
    const res = fakeRes();
    await alarmPanelCreate(req, res);

    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    const written = db.alarmPanel.calls.create[0];
    assert.strictEqual(written.name, FULL_PANEL_BODY.name);
    assert.strictEqual(written.accountNumber, 'ACCT-042');
    assert.strictEqual(written.protocol, 'sia-dc09');
    assert.strictEqual(written.panelType, 'intrusion');
    assert.strictEqual(written.make, 'DSC');
    assert.strictEqual(written.model, 'NEO-2128');
    assert.strictEqual(written.comms, 'ip');
    assert.strictEqual(written.receiverLine, 'L1');
    assert.strictEqual(written.psapAgency, 'ECU-911');
    assert.strictEqual(written.psapPhone, '911');
    assert.strictEqual(written.asapOri, 'ORI-77');
    assert.strictEqual(written.dc09Key, 'super-secret-aes-key', 'dc09Key must be stored');
    assert.strictEqual(written.supervisionMins, 15);
    assert.strictEqual(written.testIntervalHrs, 24);
    assert.strictEqual(written.status, 'online');
    assert.strictEqual(written.lastSignalAt, FULL_PANEL_BODY.lastSignalAt);
    assert.strictEqual(written.postSiteId, 'ps-1');
    assert.strictEqual(written.stationId, 'st-1');
    assert.strictEqual(written.customerId, 'ca-1');
    assert.strictEqual(written.notes, 'Instalado en rack 2');
    assert.strictEqual(written.active, true);
    assert.strictEqual(written.tenantId, TENANT);
    assert.strictEqual(written.createdById, USER_ID);
    assert.strictEqual(written.updatedById, USER_ID);
    // The AES key must never be echoed back.
    assert.strictEqual(res.body.dc09Key, undefined, 'dc09Key leaked in the response');
  });

  it('a db failure on create returns an error status, NOT a fake success', async () => {
    const db = buildDb();
    db.alarmPanel.create = async () => {
      throw new Error('panel insert failed');
    };
    const req = fakeReq(db, { params: { tenantId: TENANT }, body: { ...FULL_PANEL_BODY } });
    const res = fakeRes();
    await alarmPanelCreate(req, res);
    assert.strictEqual(res.statusCode, 500);
  });

  it('update targets {id, tenantId}, applies ONLY the sent fields and keeps dc09Key', async () => {
    const db = buildDb({
      alarmPanels: [
        {
          id: 'pnl-1',
          tenantId: TENANT,
          name: 'Panel Viejo',
          dc09Key: 'old-key',
          status: 'unknown',
          notes: 'keep-notes',
          supervisionMins: 15,
          deletedAt: null,
        },
      ],
    });
    const req = fakeReq(db, {
      params: { tenantId: TENANT, id: 'pnl-1' },
      body: { name: 'Panel Renombrado', status: 'offline', dc09Key: '' },
    });
    const res = fakeRes();
    await alarmPanelUpdate(req, res);

    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    const find = db.alarmPanel.calls.findOne[0];
    assert.strictEqual(find.where.id, 'pnl-1');
    assert.strictEqual(find.where.tenantId, TENANT);

    const row = db.alarmPanel.rows[0];
    const patch = row.__updateCalls[0];
    assert.strictEqual(patch.name, 'Panel Renombrado');
    assert.strictEqual(patch.status, 'offline');
    assert.strictEqual(patch.updatedById, USER_ID);
    assert.ok(!('notes' in patch), 'unsent field leaked into the patch');
    assert.ok(!('dc09Key' in patch), 'empty dc09Key must not overwrite the stored key');
    assert.strictEqual(row.dc09Key, 'old-key');
    assert.strictEqual(row.notes, 'keep-notes');
  });

  it('update on a foreign-tenant panel is a 404 (nothing written)', async () => {
    const db = buildDb({
      alarmPanels: [{ id: 'pnl-1', tenantId: OTHER_TENANT, name: 'Ajeno', deletedAt: null }],
    });
    const req = fakeReq(db, { params: { tenantId: TENANT, id: 'pnl-1' }, body: { name: 'Hack' } });
    const res = fakeRes();
    await alarmPanelUpdate(req, res);
    assert.strictEqual(res.statusCode, 404);
    assert.strictEqual(db.alarmPanel.rows[0].__updateCalls.length, 0);
  });
});

// ═══════════════════════════ alarm · contact ═════════════════════════════════
describe('crud-g06 · alarm contactCreate/contactUpdate handlers', () => {
  const seedPanel = { alarmPanels: [{ id: 'pnl-1', tenantId: TENANT, name: 'Panel', deletedAt: null }] };
  const FULL_CONTACT = {
    name: 'Contacto Uno',
    phone: '0999111222',
    email: 'contacto@cliente.ec',
    callOrder: 2,
    passcode: 'clave-verbal',
    authority: 'keyholder',
  };

  it('create persists every contact field, linked to the tenant panel', async () => {
    const db = buildDb(seedPanel);
    const req = fakeReq(db, { params: { tenantId: TENANT, id: 'pnl-1' }, body: { data: { ...FULL_CONTACT } } });
    const res = fakeRes();
    await alarmContactCreate(req, res);

    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    const written = db.alarmContact.calls.create[0];
    for (const [k, v] of Object.entries(FULL_CONTACT)) {
      assert.deepStrictEqual(written[k], v, `field "${k}" was dropped or altered on create`);
    }
    assert.strictEqual(written.alarmPanelId, 'pnl-1');
    assert.strictEqual(written.tenantId, TENANT);
    // The verbal passcode is stored but never echoed back.
    assert.strictEqual(res.body.passcode, undefined, 'passcode leaked in the response');
  });

  it("create against another tenant's panel is a 404 (nothing written)", async () => {
    const db = buildDb({ alarmPanels: [{ id: 'pnl-x', tenantId: OTHER_TENANT, name: 'Ajeno', deletedAt: null }] });
    const req = fakeReq(db, { params: { tenantId: TENANT, id: 'pnl-x' }, body: { ...FULL_CONTACT } });
    const res = fakeRes();
    await alarmContactCreate(req, res);
    assert.strictEqual(res.statusCode, 404);
    assert.strictEqual(db.alarmContact.calls.create.length, 0);
  });

  it('update targets {id, tenantId} and applies ONLY the sent keys (no clobber)', async () => {
    const db = buildDb({
      alarmContacts: [
        { id: 'ct-1', tenantId: TENANT, alarmPanelId: 'pnl-1', ...FULL_CONTACT, deletedAt: null },
      ],
    });
    const req = fakeReq(db, {
      params: { tenantId: TENANT, id: 'ct-1' },
      body: { data: { phone: '0988000111', callOrder: 1 } },
    });
    const res = fakeRes();
    await alarmContactUpdate(req, res);

    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    const find = db.alarmContact.calls.findOne[0];
    assert.strictEqual(find.where.id, 'ct-1');
    assert.strictEqual(find.where.tenantId, TENANT);

    const row = db.alarmContact.rows[0];
    const patch = row.__updateCalls[0];
    assert.deepStrictEqual(Object.keys(patch).sort(), ['callOrder', 'phone']);
    assert.strictEqual(row.phone, '0988000111');
    assert.strictEqual(row.callOrder, 1);
    assert.strictEqual(row.name, FULL_CONTACT.name, 'name wiped by partial update');
    assert.strictEqual(row.passcode, FULL_CONTACT.passcode, 'passcode wiped by partial update');
  });
});

// ═══════════════════════════ alarm · zone ════════════════════════════════════
describe('crud-g06 · alarm zoneCreate/zoneUpdate handlers', () => {
  const seedPanel = { alarmPanels: [{ id: 'pnl-1', tenantId: TENANT, name: 'Panel', deletedAt: null }] };
  const FULL_ZONE = {
    zoneNumber: '007',
    name: 'Puerta trasera',
    type: 'door',
    partition: 'P2',
    linkedCameraId: 'cam-3',
    bypassed: true,
  };

  it('create persists every zone field under the tenant panel', async () => {
    const db = buildDb(seedPanel);
    const req = fakeReq(db, { params: { tenantId: TENANT, id: 'pnl-1' }, body: { ...FULL_ZONE } });
    const res = fakeRes();
    await alarmZoneCreate(req, res);

    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    const written = db.alarmZone.calls.create[0];
    for (const [k, v] of Object.entries(FULL_ZONE)) {
      assert.deepStrictEqual(written[k], v, `field "${k}" was dropped or altered on create`);
    }
    assert.strictEqual(written.alarmPanelId, 'pnl-1');
    assert.strictEqual(written.tenantId, TENANT);
  });

  it('update targets {id, tenantId} and applies only the sent keys', async () => {
    const db = buildDb({
      alarmZones: [{ id: 'zn-1', tenantId: TENANT, alarmPanelId: 'pnl-1', ...FULL_ZONE, deletedAt: null }],
    });
    const req = fakeReq(db, {
      params: { tenantId: TENANT, id: 'zn-1' },
      body: { name: 'Puerta principal', bypassed: false },
    });
    const res = fakeRes();
    await alarmZoneUpdate(req, res);

    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    const find = db.alarmZone.calls.findOne[0];
    assert.strictEqual(find.where.id, 'zn-1');
    assert.strictEqual(find.where.tenantId, TENANT);

    const row = db.alarmZone.rows[0];
    const patch = row.__updateCalls[0];
    assert.deepStrictEqual(Object.keys(patch).sort(), ['bypassed', 'name']);
    assert.strictEqual(row.name, 'Puerta principal');
    assert.strictEqual(row.bypassed, false);
    assert.strictEqual(row.partition, 'P2', 'partition wiped by partial update');
    assert.strictEqual(row.linkedCameraId, 'cam-3', 'linkedCameraId wiped by partial update');
  });

  it('a db failure on zone update returns 500, not success', async () => {
    const db = buildDb({
      alarmZones: [{ id: 'zn-1', tenantId: TENANT, alarmPanelId: 'pnl-1', ...FULL_ZONE, deletedAt: null }],
    });
    db.alarmZone.rows[0].update = async () => {
      throw new Error('zone write failed');
    };
    const req = fakeReq(db, { params: { tenantId: TENANT, id: 'zn-1' }, body: { name: 'X' } });
    const res = fakeRes();
    await alarmZoneUpdate(req, res);
    assert.strictEqual(res.statusCode, 500);
  });
});

// ═══════════════════════ alarm · case lifecycle ══════════════════════════════
describe('crud-g06 · alarm caseAcknowledge/caseResolve handlers', () => {
  const seedCase = () => ({
    alarmCases: [
      {
        id: 'case-1',
        tenantId: TENANT,
        status: 'new',
        ackAt: null,
        resolvedAt: null,
        assignedOperatorId: null,
        deletedAt: null,
      },
    ],
  });

  it('acknowledge stamps status/ackAt/assignedOperatorId on the tenant-scoped case + audit row', async () => {
    const db = buildDb(seedCase());
    const req = fakeReq(db, {
      params: { tenantId: TENANT, id: 'case-1' },
      body: { data: { action: 'Se llamó al cliente' } },
    });
    const res = fakeRes();
    await alarmCaseAcknowledge(req, res);

    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    const find = db.alarmCase.calls.findOne[0];
    assert.strictEqual(find.where.id, 'case-1');
    assert.strictEqual(find.where.tenantId, TENANT);

    const row = db.alarmCase.rows[0];
    const patch = row.__updateCalls[0];
    assert.strictEqual(patch.status, 'acknowledged');
    assert.ok(patch.ackAt instanceof Date, 'ackAt not stamped');
    assert.strictEqual(patch.assignedOperatorId, USER_ID);
    assert.strictEqual(patch.updatedById, USER_ID);

    // The accountable audit trail row must be persisted with the action taken.
    const audit = db.alarmAuditLog.calls.create[0];
    assert.ok(audit, 'no alarmAuditLog row written');
    assert.strictEqual(audit.alarmCaseId, 'case-1');
    assert.strictEqual(audit.action, 'acknowledge');
    assert.ok(String(audit.detail).includes('Se llamó al cliente'), 'operator action lost from audit detail');
    assert.strictEqual(audit.tenantId, TENANT);
    assert.strictEqual(audit.actorId, USER_ID);
  });

  it('resolve stamps status/resolvedAt + audit row; keeps an earlier resolvedAt', async () => {
    const earlier = new Date('2026-07-10T00:00:00Z');
    const db = buildDb({
      alarmCases: [
        { id: 'case-1', tenantId: TENANT, status: 'acknowledged', resolvedAt: earlier, deletedAt: null },
      ],
    });
    const req = fakeReq(db, { params: { tenantId: TENANT, id: 'case-1' }, body: { note: 'Falsa alarma' } });
    const res = fakeRes();
    await alarmCaseResolve(req, res);

    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    const patch = db.alarmCase.rows[0].__updateCalls[0];
    assert.strictEqual(patch.status, 'resolved');
    assert.strictEqual(patch.resolvedAt, earlier, 'first resolvedAt must be preserved');
    const audit = db.alarmAuditLog.calls.create[0];
    assert.strictEqual(audit.action, 'resolve');
    assert.strictEqual(audit.detail, 'Falsa alarma');
  });

  it('acknowledging a foreign-tenant case is a 404 (no state change, no audit row)', async () => {
    const db = buildDb({
      alarmCases: [{ id: 'case-1', tenantId: OTHER_TENANT, status: 'new', deletedAt: null }],
    });
    const req = fakeReq(db, { params: { tenantId: TENANT, id: 'case-1' }, body: {} });
    const res = fakeRes();
    await alarmCaseAcknowledge(req, res);
    assert.strictEqual(res.statusCode, 404);
    assert.strictEqual(db.alarmCase.rows[0].__updateCalls.length, 0);
    assert.strictEqual(db.alarmAuditLog.calls.create.length, 0);
  });

  it('a db failure on resolve returns 500, not a fake success', async () => {
    const db = buildDb(seedCase());
    db.alarmCase.rows[0].update = async () => {
      throw new Error('case write failed');
    };
    const req = fakeReq(db, { params: { tenantId: TENANT, id: 'case-1' }, body: {} });
    const res = fakeRes();
    await alarmCaseResolve(req, res);
    assert.strictEqual(res.statusCode, 500);
  });
});

// ═══════════════════ security (securityAuditLog write path) ══════════════════
describe('crud-g06 · logSecurityEvent (the securityAuditLog writer)', () => {
  it('persists every event field with the length caps applied', async () => {
    const db = buildDb();
    const longEmail = 'x'.repeat(300) + '@a.ec';
    await logSecurityEvent(db, {
      tenantId: TENANT,
      userId: USER_ID,
      email: longEmail,
      event: 'signin',
      outcome: 'success',
      ip: '10.0.0.1',
      userAgent: 'Mozilla/5.0',
      deviceId: 'd'.repeat(250),
      platform: 'ios',
      detail: 'inicio de sesión correcto',
    });
    const written = db.securityAuditLog.calls.create[0];
    assert.ok(written, 'no securityAuditLog row written');
    assert.strictEqual(written.tenantId, TENANT);
    assert.strictEqual(written.userId, USER_ID);
    assert.strictEqual(written.email, longEmail.slice(0, 255), 'email not capped to the column length');
    assert.strictEqual(written.event, 'signin');
    assert.strictEqual(written.outcome, 'success');
    assert.strictEqual(written.ip, '10.0.0.1');
    assert.strictEqual(written.userAgent, 'Mozilla/5.0');
    assert.strictEqual(written.deviceId, 'd'.repeat(200), 'deviceId not capped to the column length');
    assert.strictEqual(written.platform, 'ios');
    assert.strictEqual(written.detail, 'inicio de sesión correcto');
    assert.ok(written.at instanceof Date);
  });

  it('is deliberately best-effort: a db failure never breaks the auth flow (documented design)', async () => {
    const db = buildDb();
    db.securityAuditLog.create = async () => {
      throw new Error('audit table gone');
    };
    // Must resolve — the auth path cannot die because auditing failed.
    await logSecurityEvent(db, { event: 'signin', outcome: 'failure' });
  });
});
});
