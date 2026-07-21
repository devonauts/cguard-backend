/**
 * Unit tests — op-clientes-sedes: Clientes, sedes y contratos.
 *
 * Cubre (código de producción REAL contra un fake-db in-memory tipo Sequelize —
 * sin MySQL, sin red) las llamadas que una empresa de seguridad hace sobre la
 * ficha del cliente y su contrato, extendiendo lo ya cubierto por crud-g01
 * (clientAccount/contacts repo, clientProject, pivot) y crud-g02 (businessInfo/
 * station/category). Aquí se ejercitan los HANDLERS express que g01/g02 no tocan:
 *
 *   - clientAccountContractUpdate      (términos de contrato/SLA, coerciones,
 *                                       scope por tenant, sin null-clobber)
 *   - contractServiceWrite             (servicios contratados: create/update/
 *                                       destroy; fidelidad, scope tenant+cliente)
 *   - contractRenewalWrite             (renovaciones de contrato: CRUD + scope)
 *   - clientAccountContract            (lectura agregada: scope tenant, servicios
 *                                       y renovaciones filtrados por cliente)
 *   - clientAccountNote*               (notas del cliente: pin notableType,
 *                                       IDOR cross-cliente, list scope) + BUG
 *   - clientAccountContact*            (contactos: pin clientAccountId, IDOR)
 *   - assertClientAccess               (scope POR CLIENTE: un customer solo ve lo
 *                                       suyo; staff pasa; pivot multi-acceso)
 *   - clientAccountActivity            (fan-out cliente→CRM: feed unificado)
 *   - ClientAccountRepository.create   (mapeo commercialName/empresa vs
 *                                       name/lastName/representante)
 *
 * Reglas: cada test AFIRMA algo real (campo persiste con valor exacto, error se
 * propaga como 400/403/404 y no como 200/500, scope por tenant/cliente,
 * transición de estado). Hooks describe-scoped (nunca a nivel raíz).
 *
 * Run:
 *   cross-env NODE_ENV=test TS_NODE_PROJECT=tsconfig.test.json \
 *     npx mocha -r ts-node/register \
 *     'tests/unit/op-clientes-sedes/**\/*.test.ts' --exit --timeout 20000
 */

import assert from 'assert';
import sinon from 'sinon';
import Sequelize from 'sequelize';

import ClientAccountRepository from '../../../src/database/repositories/clientAccountRepository';
import AuditLogRepository from '../../../src/database/repositories/auditLogRepository';
import FileRepository from '../../../src/database/repositories/fileRepository';
import AttachmentRepository from '../../../src/database/repositories/attachmentRepository';

import clientAccountContractUpdate from '../../../src/api/clientAccount/clientAccountContractUpdate';
import clientAccountContract from '../../../src/api/clientAccount/clientAccountContract';
import * as contractServiceWrite from '../../../src/api/clientAccount/contractServiceWrite';
import * as contractRenewalWrite from '../../../src/api/clientAccount/contractRenewalWrite';
import clientAccountNoteCreate from '../../../src/api/clientAccount/clientAccountNoteCreate';
import clientAccountNoteUpdate from '../../../src/api/clientAccount/clientAccountNoteUpdate';
import clientAccountNoteDestroy from '../../../src/api/clientAccount/clientAccountNoteDestroy';
import clientAccountNotes from '../../../src/api/clientAccount/clientAccountNotes';
import clientAccountContactCreate from '../../../src/api/clientAccount/clientAccountContactCreate';
import clientAccountContactUpdate from '../../../src/api/clientAccount/clientAccountContactUpdate';
import clientAccountContactDestroy from '../../../src/api/clientAccount/clientAccountContactDestroy';
import clientAccountContacts from '../../../src/api/clientAccount/clientAccountContacts';
import clientAccountActivity from '../../../src/api/clientAccount/clientAccountActivity';
import assertClientAccess from '../../../src/services/user/assertClientAccess';

const Op = Sequelize.Op;

const TENANT = 'aaaaaaaa-0000-0000-0000-000000000001';
const OTHER_TENANT = 'bbbbbbbb-0000-0000-0000-000000000002';
const USER_ID = 'user-1';
// Valid UUIDs: the list filters route ids through SequelizeFilterUtils.uuid(),
// which swaps any NON-uuid for a random one (so a non-uuid id would never match).
const CLIENT_A = '11111111-1111-4111-8111-111111111111';
const CLIENT_B = '22222222-2222-4222-8222-222222222222';

// ──────────────────────── fake db (Sequelize-shaped) ─────────────────────────
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
    async getLogoUrl() { return null; },
    async getPlacePictureUrl() { return null; },
  };
  return row;
}

/** Where matcher: plain equality + Op.ne / Op.in / Op.and / Op.or / Op.gte / Op.between. */
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
    if (typeof key === 'symbol') continue;
    const col = key as string;
    if (Array.isArray(cond)) {
      if (!cond.includes(row[col])) return false;
      continue;
    }
    if (cond !== null && typeof cond === 'object' && !(cond instanceof Date)) {
      const syms = Object.getOwnPropertySymbols(cond);
      if (syms.length) {
        for (const s of syms) {
          const v = (cond as any)[s];
          if (s === Op.ne && row[col] === v) return false;
          if (s === Op.in && !(Array.isArray(v) && v.includes(row[col]))) return false;
          if (s === Op.gte && !(row[col] != null && new Date(row[col]) >= new Date(v))) return false;
          if (s === Op.between) {
            const t = row[col] != null ? new Date(row[col]).getTime() : null;
            if (t == null || t < new Date(v[0]).getTime() || t > new Date(v[1]).getTime()) return false;
          }
        }
        continue;
      }
    }
    if (row[col] !== cond) return false;
  }
  return true;
}

function makeModel(name: string, seed: any[] = []) {
  const model: any = {
    __name: name,
    rows: seed.map(makeRow),
    calls: { create: [] as any[], findOne: [] as any[], findAll: [] as any[], findAndCountAll: [] as any[], destroy: [] as any[], count: [] as any[] },
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
    async findAndCountAll(q: any = {}) {
      model.calls.findAndCountAll.push(q);
      const rows = model.rows.filter((r: any) => !r.__destroyed && matchWhere(r, q.where));
      return { rows, count: rows.length };
    },
    async findByPk(id: any) {
      return model.rows.find((r: any) => r.id === id && !r.__destroyed) || null;
    },
    async count(q: any = {}) {
      model.calls.count.push(q);
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

function buildDb(seed: any = {}) {
  const db: any = {
    Sequelize,
    clientAccount: makeModel('clientAccount', seed.clientAccounts || []),
    businessInfo: makeModel('businessInfo', seed.businessInfos || []),
    station: makeModel('station', seed.stations || []),
    note: makeModel('note', seed.notes || []),
    clientContact: makeModel('clientContact', seed.clientContacts || []),
    contractService: makeModel('contractService', seed.contractServices || []),
    contractRenewal: makeModel('contractRenewal', seed.contractRenewals || []),
    tenant: makeModel('tenant', seed.tenants || []),
    user: makeModel('user', seed.users || []),
    auditLog: makeModel('auditLog', []),
    attachment: makeModel('attachment', []),
    guardShift: makeModel('guardShift', seed.guardShifts || []),
    incident: makeModel('incident', seed.incidents || []),
    visitorLog: makeModel('visitorLog', seed.visitorLogs || []),
    task: makeModel('task', []),
    tourAssignment: makeModel('tourAssignment', []),
    shiftPassdown: makeModel('shiftPassdown', []),
    securityGuard: makeModel('securityGuard', seed.securityGuards || []),
    videoDevice: makeModel('videoDevice', []),
    siteTourTag: makeModel('siteTourTag', []),
    tenant_user_client_accounts: makeModel('tenant_user_client_account', seed.pivots || []),
  };
  db.sequelize = {
    async transaction() { return { commit: async () => {}, rollback: async () => {} }; },
    // assertClientAccess pivot lookup: default = no grant.
    query: seed.pivotGrant
      ? async () => [[{ '1': 1 }]]
      : async () => [[]],
  };
  return db;
}

function adminUser(tenantId = TENANT) {
  return {
    id: USER_ID,
    email: 'ops@example.com',
    emailVerified: true,
    isSuperadmin: true,
    tenants: [{ tenant: { id: tenantId }, status: 'active', roles: ['admin'] }],
  };
}

function customerUser(tenantId = TENANT, userId = 'cust-1') {
  return {
    id: userId,
    email: 'cliente@x.ec',
    emailVerified: true,
    isSuperadmin: false,
    tenants: [{ tenant: { id: tenantId }, status: 'active', roles: ['customer'] }],
  };
}

function repoOptions(db: any, tenantId = TENANT) {
  return {
    currentUser: { id: USER_ID },
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

// ═══════════════ contract terms update (clientAccountContractUpdate) ══════════
describe('op-clientes-sedes · clientAccountContractUpdate (términos de contrato)', () => {
  beforeEach(() => {
    if ((AuditLogRepository as any).log?.restore) (AuditLogRepository as any).log.restore();
    sinon.stub(AuditLogRepository, 'log').resolves();
  });
  afterEach(() => sinon.restore());

  const EXISTING = () => ({
    id: CLIENT_A, tenantId: TENANT, name: 'Rep. Legal', commercialName: 'Andina S.A.',
    contractNumber: 'K-001', contractType: 'fijo', currency: 'USD', paymentTerms: '30 días',
    contractedHoursPerMonth: 720, contractNotes: 'nota vieja', autoRenew: false,
    slaResponseMinutes: 15, deletedAt: null,
  });

  it('persiste solo los campos de contrato con coerción INT/boolean correcta', async () => {
    const db = buildDb({ clientAccounts: [EXISTING()] });
    const body = {
      data: {
        contractNumber: 'K-777', contractType: 'temporal', currency: 'USD',
        paymentTerms: 'contado', contractDate: '2026-01-01', contractEndDate: '2026-12-31',
        autoRenew: 'true', autoRenewDaysBefore: '30', penaltyClause: 'multa 10%',
        earlyCancellationNotice: '60 días', jurisdiction: 'Quito',
        contractedHoursPerMonth: '744', contractNotes: 'nueva nota',
        slaUptimeTarget: '99', slaResponseMinutes: '10', slaRoundsTarget: '8', slaReportsTarget: '4',
      },
    };
    const req = fakeReq(db, { params: { id: CLIENT_A }, body });
    const res = fakeRes();
    await clientAccountContractUpdate(req, res);

    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    const row = db.clientAccount.rows[0];
    const patch = row.__updateCalls[0];
    assert.strictEqual(patch.contractNumber, 'K-777');
    assert.strictEqual(patch.contractType, 'temporal');
    assert.strictEqual(patch.autoRenew, true, 'autoRenew "true" debe coercionar a boolean true');
    assert.strictEqual(patch.autoRenewDaysBefore, 30, 'INT debe parsearse');
    assert.strictEqual(patch.contractedHoursPerMonth, 744);
    assert.strictEqual(patch.slaUptimeTarget, 99);
    assert.strictEqual(patch.slaResponseMinutes, 10);
    assert.strictEqual(patch.slaRoundsTarget, 8);
    assert.strictEqual(patch.slaReportsTarget, 4);
    assert.strictEqual(patch.jurisdiction, 'Quito');
    // valores string vacíos → null
  });

  it('empty string en un término SE convierte a null (limpieza explícita)', async () => {
    const db = buildDb({ clientAccounts: [EXISTING()] });
    const req = fakeReq(db, { params: { id: CLIENT_A }, body: { data: { contractNumber: '', contractedHoursPerMonth: '' } } });
    const res = fakeRes();
    await clientAccountContractUpdate(req, res);
    const patch = db.clientAccount.rows[0].__updateCalls[0];
    assert.strictEqual(patch.contractNumber, null);
    assert.strictEqual(patch.contractedHoursPerMonth, null);
  });

  it('un update parcial NO toca términos no enviados (presence-guard)', async () => {
    const db = buildDb({ clientAccounts: [EXISTING()] });
    const req = fakeReq(db, { params: { id: CLIENT_A }, body: { data: { contractNotes: 'solo nota' } } });
    const res = fakeRes();
    await clientAccountContractUpdate(req, res);

    const patch = db.clientAccount.rows[0].__updateCalls[0];
    assert.deepStrictEqual(Object.keys(patch), ['contractNotes'], 'solo la clave enviada llega al patch');
    const row = db.clientAccount.rows[0];
    assert.strictEqual(row.contractNumber, 'K-001', 'contractNumber no debe borrarse');
    assert.strictEqual(row.contractedHoursPerMonth, 720, 'horas no deben borrarse');
    assert.strictEqual(row.slaResponseMinutes, 15, 'SLA no debe borrarse');
  });

  it('cliente de OTRO tenant → 404 y no escribe nada', async () => {
    const db = buildDb({ clientAccounts: [{ ...EXISTING(), tenantId: OTHER_TENANT }] });
    const req = fakeReq(db, { params: { id: CLIENT_A }, body: { data: { contractNumber: 'HACK' } } });
    const res = fakeRes();
    await clientAccountContractUpdate(req, res);
    assert.strictEqual(res.statusCode, 404);
    assert.strictEqual(db.clientAccount.rows[0].__updateCalls.length, 0);
  });

  it('un fallo de db en update se propaga como 500 (no falso 200)', async () => {
    const db = buildDb({ clientAccounts: [EXISTING()] });
    db.clientAccount.rows[0].update = async () => { throw new Error('boom'); };
    const req = fakeReq(db, { params: { id: CLIENT_A }, body: { data: { contractNumber: 'X' } } });
    const res = fakeRes();
    await clientAccountContractUpdate(req, res);
    assert.strictEqual(res.statusCode, 500);
  });
});

// ═════════════════ contractService write (servicios contratados) ═════════════
describe('op-clientes-sedes · contractServiceWrite (servicios del contrato)', () => {
  afterEach(() => sinon.restore());

  const FULL = {
    serviceKey: 'fixed_guard', name: 'Vigilancia fija 24h', description: 'Dos vigilantes por turno',
    unit: 'puesto', contractedQty: '3', slaTarget: '95', sortOrder: '1', active: true,
  };

  it('create persiste cada campo + coerción INT + stamps tenant/cliente/usuario', async () => {
    const db = buildDb();
    const req = fakeReq(db, { params: { id: CLIENT_A }, body: { data: { ...FULL } } });
    const res = fakeRes();
    await contractServiceWrite.create(req, res);

    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    const w = db.contractService.calls.create[0];
    assert.strictEqual(w.serviceKey, 'fixed_guard');
    assert.strictEqual(w.name, 'Vigilancia fija 24h');
    assert.strictEqual(w.description, 'Dos vigilantes por turno');
    assert.strictEqual(w.unit, 'puesto');
    assert.strictEqual(w.contractedQty, 3);
    assert.strictEqual(w.slaTarget, 95);
    assert.strictEqual(w.sortOrder, 1);
    assert.strictEqual(w.active, true);
    assert.strictEqual(w.tenantId, TENANT);
    assert.strictEqual(w.clientAccountId, CLIENT_A);
    assert.strictEqual(w.createdById, USER_ID);
  });

  it('create sin name → 400 y NO inserta', async () => {
    const db = buildDb();
    const req = fakeReq(db, { params: { id: CLIENT_A }, body: { data: { description: 'sin nombre' } } });
    const res = fakeRes();
    await contractServiceWrite.create(req, res);
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(db.contractService.calls.create.length, 0);
  });

  it('create sin serviceKey usa "custom" y active por defecto true', async () => {
    const db = buildDb();
    const req = fakeReq(db, { params: { id: CLIENT_A }, body: { data: { name: 'Servicio a medida' } } });
    const res = fakeRes();
    await contractServiceWrite.create(req, res);
    const w = db.contractService.calls.create[0];
    assert.strictEqual(w.serviceKey, 'custom');
    assert.strictEqual(w.active, true);
  });

  it('update parcial NO borra campos no enviados (presence-guard)', async () => {
    const db = buildDb({
      contractServices: [{ id: 'cs-1', tenantId: TENANT, clientAccountId: CLIENT_A, serviceKey: 'fixed_guard', name: 'Fijo', description: 'mantener', contractedQty: 3, slaTarget: 95, active: true, deletedAt: null }],
    });
    const req = fakeReq(db, { params: { id: CLIENT_A, serviceId: 'cs-1' }, body: { data: { name: 'Fijo Renombrado' } } });
    const res = fakeRes();
    await contractServiceWrite.update(req, res);
    assert.strictEqual(res.statusCode, 200);
    const row = db.contractService.rows[0];
    assert.strictEqual(row.name, 'Fijo Renombrado');
    assert.strictEqual(row.description, 'mantener', 'description no debe borrarse');
    assert.strictEqual(row.contractedQty, 3, 'cantidad no debe borrarse');
    assert.strictEqual(row.slaTarget, 95, 'SLA no debe borrarse');
    assert.strictEqual(row.updatedById, USER_ID);
  });

  it('update de servicio de OTRO tenant → 404, sin escribir', async () => {
    const db = buildDb({
      contractServices: [{ id: 'cs-1', tenantId: OTHER_TENANT, clientAccountId: CLIENT_A, name: 'X', deletedAt: null }],
    });
    const req = fakeReq(db, { params: { id: CLIENT_A, serviceId: 'cs-1' }, body: { data: { name: 'HACK' } } });
    const res = fakeRes();
    await contractServiceWrite.update(req, res);
    assert.strictEqual(res.statusCode, 404);
    assert.strictEqual(db.contractService.rows[0].__updateCalls.length, 0);
  });

  it('update de servicio de OTRO cliente (mismo tenant) → 404 (IDOR cross-cliente)', async () => {
    const db = buildDb({
      contractServices: [{ id: 'cs-1', tenantId: TENANT, clientAccountId: CLIENT_B, name: 'X', deletedAt: null }],
    });
    const req = fakeReq(db, { params: { id: CLIENT_A, serviceId: 'cs-1' }, body: { data: { name: 'HACK' } } });
    const res = fakeRes();
    await contractServiceWrite.update(req, res);
    assert.strictEqual(res.statusCode, 404, 'no se puede editar el servicio de otro cliente vía su path');
    assert.strictEqual(db.contractService.rows[0].__updateCalls.length, 0);
  });

  it('destroy elimina (soft) solo si tenant + cliente coinciden', async () => {
    const db = buildDb({
      contractServices: [{ id: 'cs-1', tenantId: TENANT, clientAccountId: CLIENT_A, name: 'X', deletedAt: null }],
    });
    const req = fakeReq(db, { params: { id: CLIENT_A, serviceId: 'cs-1' } });
    const res = fakeRes();
    await contractServiceWrite.destroy(req, res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(db.contractService.rows[0].__destroyed, true);
    assert.strictEqual(res.body.deleted, true);
  });

  it('destroy de servicio de otro cliente → 404, no elimina', async () => {
    const db = buildDb({
      contractServices: [{ id: 'cs-1', tenantId: TENANT, clientAccountId: CLIENT_B, name: 'X', deletedAt: null }],
    });
    const req = fakeReq(db, { params: { id: CLIENT_A, serviceId: 'cs-1' } });
    const res = fakeRes();
    await contractServiceWrite.destroy(req, res);
    assert.strictEqual(res.statusCode, 404);
    assert.strictEqual(db.contractService.rows[0].__destroyed, false);
  });
});

// ═════════════════ contractRenewal write (renovaciones) ══════════════════════
describe('op-clientes-sedes · contractRenewalWrite (renovaciones de contrato)', () => {
  afterEach(() => sinon.restore());

  it('create persiste cada campo + status por defecto "active" + stamps', async () => {
    const db = buildDb();
    const body = { data: { periodLabel: '2026', fromDate: '2026-01-01', toDate: '2026-12-31', durationMonths: '12' } };
    const req = fakeReq(db, { params: { id: CLIENT_A }, body });
    const res = fakeRes();
    await contractRenewalWrite.create(req, res);

    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    const w = db.contractRenewal.calls.create[0];
    assert.strictEqual(w.periodLabel, '2026');
    assert.strictEqual(w.fromDate, '2026-01-01');
    assert.strictEqual(w.toDate, '2026-12-31');
    assert.strictEqual(w.durationMonths, 12);
    assert.strictEqual(w.status, 'active');
    assert.strictEqual(w.tenantId, TENANT);
    assert.strictEqual(w.clientAccountId, CLIENT_A);
    assert.strictEqual(w.createdById, USER_ID);
  });

  it('create respeta status explícito (transición a "finished")', async () => {
    const db = buildDb();
    const req = fakeReq(db, { params: { id: CLIENT_A }, body: { data: { periodLabel: '2025', status: 'finished' } } });
    const res = fakeRes();
    await contractRenewalWrite.create(req, res);
    assert.strictEqual(db.contractRenewal.calls.create[0].status, 'finished');
  });

  it('update parcial NO borra campos no enviados', async () => {
    const db = buildDb({
      contractRenewals: [{ id: 'cr-1', tenantId: TENANT, clientAccountId: CLIENT_A, periodLabel: '2026', durationMonths: 12, status: 'active', deletedAt: null }],
    });
    const req = fakeReq(db, { params: { id: CLIENT_A, renewalId: 'cr-1' }, body: { data: { status: 'finished' } } });
    const res = fakeRes();
    await contractRenewalWrite.update(req, res);
    assert.strictEqual(res.statusCode, 200);
    const row = db.contractRenewal.rows[0];
    assert.strictEqual(row.status, 'finished');
    assert.strictEqual(row.periodLabel, '2026', 'periodLabel no debe borrarse');
    assert.strictEqual(row.durationMonths, 12, 'durationMonths no debe borrarse');
  });

  it('update de renovación de otro cliente → 404 (IDOR cross-cliente)', async () => {
    const db = buildDb({
      contractRenewals: [{ id: 'cr-1', tenantId: TENANT, clientAccountId: CLIENT_B, periodLabel: 'X', status: 'active', deletedAt: null }],
    });
    const req = fakeReq(db, { params: { id: CLIENT_A, renewalId: 'cr-1' }, body: { data: { status: 'finished' } } });
    const res = fakeRes();
    await contractRenewalWrite.update(req, res);
    assert.strictEqual(res.statusCode, 404);
    assert.strictEqual(db.contractRenewal.rows[0].__updateCalls.length, 0);
  });

  it('destroy solo si tenant + cliente coinciden', async () => {
    const db = buildDb({
      contractRenewals: [{ id: 'cr-1', tenantId: TENANT, clientAccountId: CLIENT_A, status: 'active', deletedAt: null }],
    });
    const req = fakeReq(db, { params: { id: CLIENT_A, renewalId: 'cr-1' } });
    const res = fakeRes();
    await contractRenewalWrite.destroy(req, res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(db.contractRenewal.rows[0].__destroyed, true);
  });
});

// ═══════════════ contract aggregate read (clientAccountContract) ══════════════
describe('op-clientes-sedes · clientAccountContract (lectura agregada del contrato)', () => {
  afterEach(() => sinon.restore());

  it('cliente de otro tenant → 404', async () => {
    const db = buildDb({ clientAccounts: [{ id: CLIENT_A, tenantId: OTHER_TENANT, deletedAt: null }] });
    const req = fakeReq(db, { params: { id: CLIENT_A } });
    const res = fakeRes();
    await clientAccountContract(req, res);
    assert.strictEqual(res.statusCode, 404);
  });

  it('devuelve términos + servicios y renovaciones SOLO de este cliente/tenant', async () => {
    const db = buildDb({
      clientAccounts: [{ id: CLIENT_A, tenantId: TENANT, name: 'Andina', contractEndDate: '2027-01-01', contractedHoursPerMonth: 744, deletedAt: null }],
      tenants: [{ id: TENANT, timezone: 'America/Guayaquil' }],
      contractServices: [
        { id: 'cs-1', tenantId: TENANT, clientAccountId: CLIENT_A, serviceKey: 'fixed_guard', name: 'Fijo', contractedQty: 3, sortOrder: 1, deletedAt: null },
        { id: 'cs-2', tenantId: TENANT, clientAccountId: CLIENT_B, serviceKey: 'fixed_guard', name: 'Ajeno', deletedAt: null },
      ],
      contractRenewals: [
        { id: 'cr-1', tenantId: TENANT, clientAccountId: CLIENT_A, periodLabel: '2026', fromDate: '2026-01-01', deletedAt: null },
        { id: 'cr-2', tenantId: OTHER_TENANT, clientAccountId: CLIENT_A, periodLabel: 'ajeno', fromDate: '2026-01-01', deletedAt: null },
      ],
    });
    const req = fakeReq(db, { params: { id: CLIENT_A } });
    const res = fakeRes();
    await clientAccountContract(req, res);

    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.contract.name, 'Andina');
    assert.strictEqual(res.body.services.length, 1, 'solo el servicio de este cliente');
    assert.strictEqual(res.body.services[0].id, 'cs-1');
    assert.strictEqual(res.body.renewals.length, 1, 'solo la renovación de este tenant');
    assert.strictEqual(res.body.renewals[0].id, 'cr-1');
    assert.strictEqual(res.body.derived.hoursContracted, 744);
    assert.strictEqual(res.body.derived.tenantTimezone, 'America/Guayaquil');
  });
});

// ═══════════════════════ client notes handlers ══════════════════════════════
describe('op-clientes-sedes · notas del cliente (handlers)', () => {
  beforeEach(() => {
    if ((AuditLogRepository as any).log?.restore) (AuditLogRepository as any).log.restore();
    sinon.stub(AuditLogRepository, 'log').resolves();
    if ((AttachmentRepository as any).findAndCountAll?.restore) (AttachmentRepository as any).findAndCountAll.restore();
    sinon.stub(AttachmentRepository, 'findAndCountAll').resolves({ rows: [], count: 0 } as any);
    if ((AttachmentRepository as any).findByNotableIds?.restore) (AttachmentRepository as any).findByNotableIds.restore();
    sinon.stub(AttachmentRepository, 'findByNotableIds').resolves([] as any);
  });
  afterEach(() => sinon.restore());

  it('create fija notableType=clientAccount / notableId=cliente y persiste el contenido', async () => {
    const db = buildDb({ clientAccounts: [{ id: CLIENT_A, tenantId: TENANT, deletedAt: null }] });
    const req = fakeReq(db, {
      params: { id: CLIENT_A },
      body: { title: 'Novedad', description: 'Se cambió cerradura', noteDate: '2026-07-13T10:00:00Z' },
    });
    const res = fakeRes();
    await clientAccountNoteCreate(req, res, () => undefined);

    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    const w = db.note.calls.create[0];
    assert.strictEqual(w.title, 'Novedad');
    assert.strictEqual(w.description, 'Se cambió cerradura');
    assert.strictEqual(w.notableType, 'clientAccount');
    assert.strictEqual(w.notableId, CLIENT_A);
    assert.strictEqual(w.tenantId, TENANT);
  });

  it('list filtra por notableType=clientAccount + notableId del path (scope por cliente)', async () => {
    const db = buildDb({
      clientAccounts: [{ id: CLIENT_A, tenantId: TENANT, deletedAt: null }],
      notes: [
        { id: 'n-1', tenantId: TENANT, notableType: 'clientAccount', notableId: CLIENT_A, title: 'mía', deletedAt: null },
        { id: 'n-2', tenantId: TENANT, notableType: 'clientAccount', notableId: CLIENT_B, title: 'ajena', deletedAt: null },
        { id: 'n-3', tenantId: TENANT, notableType: 'postSite', notableId: CLIENT_A, title: 'otra entidad', deletedAt: null },
      ],
    });
    const req = fakeReq(db, { params: { id: CLIENT_A }, query: {} });
    const res = fakeRes();
    await clientAccountNotes(req, res, () => undefined);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.count, 1, 'solo la nota de ESTE cliente y tipo clientAccount');
    assert.strictEqual(res.body.rows[0].id, 'n-1');
  });

  // IDOR cross-cliente: una nota de CLIENT_B no puede editarse bajo el path de CLIENT_A.
  it('update de una nota de OTRO cliente bajo mi path → 403 (assertClientOwnsSubResource)', async () => {
    const db = buildDb({
      clientAccounts: [{ id: CLIENT_A, tenantId: TENANT, deletedAt: null }],
      notes: [{ id: 'n-9', tenantId: TENANT, notableType: 'clientAccount', notableId: CLIENT_B, title: 'ajena', description: 'secreto', deletedAt: null }],
    });
    const req = fakeReq(db, { params: { id: CLIENT_A, noteId: 'n-9' }, body: { title: 'HACK' } });
    const res = fakeRes();
    await clientAccountNoteUpdate(req, res, () => undefined);
    assert.strictEqual(res.statusCode, 403, 'nota de otro cliente en mi path debe dar 403');
    assert.strictEqual(db.note.rows[0].__updateCalls.length, 0, 'no debe escribir');
  });

  it('update de una nota de OTRO tenant → 404', async () => {
    const db = buildDb({
      clientAccounts: [{ id: CLIENT_A, tenantId: TENANT, deletedAt: null }],
      notes: [{ id: 'n-9', tenantId: OTHER_TENANT, notableType: 'clientAccount', notableId: CLIENT_A, title: 'ajena', deletedAt: null }],
    });
    const req = fakeReq(db, { params: { id: CLIENT_A, noteId: 'n-9' }, body: { title: 'HACK' } });
    const res = fakeRes();
    await clientAccountNoteUpdate(req, res, () => undefined);
    assert.strictEqual(res.statusCode, 404);
  });

  it('destroy de una nota de otro cliente → 403, no elimina', async () => {
    const db = buildDb({
      clientAccounts: [{ id: CLIENT_A, tenantId: TENANT, deletedAt: null }],
      notes: [{ id: 'n-9', tenantId: TENANT, notableType: 'clientAccount', notableId: CLIENT_B, title: 'ajena', deletedAt: null }],
    });
    const req = fakeReq(db, { params: { id: CLIENT_A, noteId: 'n-9' } });
    const res = fakeRes();
    await clientAccountNoteDestroy(req, res, () => undefined);
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(db.note.rows[0].__destroyed, false);
  });

  // BUG (null-clobber): NoteRepository.update escribe description/noteDate/
  // attachment como `data.X || null` SIN presence-guard. Un update parcial que
  // sólo cambia el título BORRA la descripción, la fecha y los adjuntos previos.
  // (ClientContactRepository.update sí fue corregido con presence-guard; note NO.)
  // Este test PINEA el comportamiento actual (defectuoso) para dejar constancia.
  it('FIXED: update parcial de nota CONSERVA description/noteDate (presence-guard)', async () => {
    const db = buildDb({
      clientAccounts: [{ id: CLIENT_A, tenantId: TENANT, deletedAt: null }],
      notes: [{ id: 'n-1', tenantId: TENANT, notableType: 'clientAccount', notableId: CLIENT_A, title: 'orig', description: 'MANTENER ESTO', noteDate: '2026-01-01T00:00:00Z', deletedAt: null }],
    });
    const req = fakeReq(db, { params: { id: CLIENT_A, noteId: 'n-1' }, body: { title: 'solo nuevo título' } });
    const res = fakeRes();
    await clientAccountNoteUpdate(req, res, () => undefined);

    assert.strictEqual(res.statusCode, 200);
    const row = db.note.rows[0];
    assert.strictEqual(row.title, 'solo nuevo título');
    // Editar solo el título ya NO borra el cuerpo/fecha de la nota.
    assert.strictEqual(row.description, 'MANTENER ESTO', 'description conservada en update parcial');
    assert.strictEqual(row.noteDate, '2026-01-01T00:00:00Z', 'noteDate conservada en update parcial');
  });
});

// ═══════════════════════ client contacts handlers ═══════════════════════════
describe('op-clientes-sedes · contactos del cliente (handlers)', () => {
  beforeEach(() => {
    if ((AuditLogRepository as any).log?.restore) (AuditLogRepository as any).log.restore();
    sinon.stub(AuditLogRepository, 'log').resolves();
  });
  afterEach(() => sinon.restore());

  it('create fija clientAccountId del path y persiste nombre/email/mobile/allowGuard', async () => {
    const db = buildDb({ clientAccounts: [{ id: CLIENT_A, tenantId: TENANT, deletedAt: null }] });
    const req = fakeReq(db, {
      params: { id: CLIENT_A },
      body: { name: 'Contacto Uno', email: 'c1@x.ec', mobile: '0991112233', description: 'Jefe de seguridad', allowGuard: true },
    });
    const res = fakeRes();
    await clientAccountContactCreate(req, res, () => undefined);

    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    const w = db.clientContact.calls.create[0];
    assert.strictEqual(w.name, 'Contacto Uno');
    assert.strictEqual(w.email, 'c1@x.ec');
    assert.strictEqual(w.mobile, '0991112233');
    assert.strictEqual(w.description, 'Jefe de seguridad');
    assert.strictEqual(w.allowGuard, true);
    assert.strictEqual(w.clientAccountId, CLIENT_A);
    assert.strictEqual(w.tenantId, TENANT);
  });

  // Hallazgo de contrato: el OpenAPI del handler anuncia phoneNumber/position/
  // lastName/address, pero el modelo clientContact SOLO tiene mobile (no
  // phoneNumber) y no tiene position/lastName/address. Un teléfono tecleado como
  // `phoneNumber` en el form se PIERDE silenciosamente (el repo sólo lee mobile).
  it('FIXED: phoneNumber→mobile y position se guardan al crear un contacto', async () => {
    const db = buildDb({ clientAccounts: [{ id: CLIENT_A, tenantId: TENANT, deletedAt: null }] });
    const req = fakeReq(db, {
      params: { id: CLIENT_A },
      body: { name: 'Contacto', phoneNumber: '022345678', position: 'Gerente' },
    });
    const res = fakeRes();
    await clientAccountContactCreate(req, res, () => undefined);
    const w = db.clientContact.calls.create[0];
    // El repo ahora acepta phoneNumber como alias de mobile y persiste el cargo.
    assert.strictEqual(w.mobile, '022345678', 'phoneNumber se mapea a mobile');
    assert.strictEqual(w.position, 'Gerente', 'el cargo (position) se persiste');
  });

  it('list filtra por clientAccountId del path (scope por cliente)', async () => {
    const db = buildDb({
      clientAccounts: [{ id: CLIENT_A, tenantId: TENANT, deletedAt: null }],
      clientContacts: [
        { id: 'cc-1', tenantId: TENANT, clientAccountId: CLIENT_A, name: 'mío', deletedAt: null },
        { id: 'cc-2', tenantId: TENANT, clientAccountId: CLIENT_B, name: 'ajeno', deletedAt: null },
      ],
    });
    const req = fakeReq(db, { params: { id: CLIENT_A }, query: {} });
    const res = fakeRes();
    await clientAccountContacts(req, res, () => undefined);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.count, 1);
    assert.strictEqual(res.body.rows[0].id, 'cc-1');
  });

  it('update de un contacto de OTRO cliente bajo mi path → 403 (IDOR)', async () => {
    const db = buildDb({
      clientAccounts: [{ id: CLIENT_A, tenantId: TENANT, deletedAt: null }],
      clientContacts: [{ id: 'cc-9', tenantId: TENANT, clientAccountId: CLIENT_B, name: 'ajeno', email: 'secreto@x.ec', deletedAt: null }],
    });
    const req = fakeReq(db, { params: { id: CLIENT_A, contactId: 'cc-9' }, body: { name: 'HACK' } });
    const res = fakeRes();
    await clientAccountContactUpdate(req, res, () => undefined);
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(db.clientContact.rows[0].__updateCalls.length, 0);
  });

  it('destroy de un contacto de otro tenant → 404, no elimina', async () => {
    const db = buildDb({
      clientAccounts: [{ id: CLIENT_A, tenantId: TENANT, deletedAt: null }],
      clientContacts: [{ id: 'cc-9', tenantId: OTHER_TENANT, clientAccountId: CLIENT_A, name: 'ajeno', deletedAt: null }],
    });
    const req = fakeReq(db, { params: { id: CLIENT_A, contactId: 'cc-9' } });
    const res = fakeRes();
    await clientAccountContactDestroy(req, res, () => undefined);
    assert.strictEqual(res.statusCode, 404);
    assert.strictEqual(db.clientContact.rows[0].__destroyed, false);
  });
});

// ══════════════════ scope POR CLIENTE (assertClientAccess) ═══════════════════
describe('op-clientes-sedes · assertClientAccess (scope por cliente)', () => {
  afterEach(() => sinon.restore());

  it('staff/admin pasa aunque el clientAccountId no sea suyo', async () => {
    const db = buildDb({ clientAccounts: [{ id: CLIENT_A, tenantId: TENANT, userId: 'someone-else', deletedAt: null }] });
    const req = fakeReq(db, { currentUser: adminUser() });
    await assert.doesNotReject(assertClientAccess(req, CLIENT_A));
  });

  it('customer accede a SU propio clientAccount (userId coincide)', async () => {
    const db = buildDb({ clientAccounts: [{ id: CLIENT_A, tenantId: TENANT, userId: 'cust-1', deletedAt: null }] });
    const req = fakeReq(db, { currentUser: customerUser(TENANT, 'cust-1') });
    await assert.doesNotReject(assertClientAccess(req, CLIENT_A));
  });

  it('customer NO accede al clientAccount de otro → 403', async () => {
    const db = buildDb({
      clientAccounts: [
        { id: CLIENT_A, tenantId: TENANT, userId: 'otro-usuario', deletedAt: null },
        { id: CLIENT_B, tenantId: TENANT, userId: 'cust-1', deletedAt: null },
      ],
    });
    const req = fakeReq(db, { currentUser: customerUser(TENANT, 'cust-1') });
    await assert.rejects(assertClientAccess(req, CLIENT_A), (e: any) => e.code === 403);
  });

  it('customer con grant en el pivot multi-acceso SÍ accede', async () => {
    const db = buildDb({
      clientAccounts: [{ id: CLIENT_A, tenantId: TENANT, userId: 'otro-usuario', deletedAt: null }],
      pivotGrant: true,
    });
    const req = fakeReq(db, { currentUser: customerUser(TENANT, 'cust-1') });
    await assert.doesNotReject(assertClientAccess(req, CLIENT_A));
  });

  it('sin membresía activa en el tenant → 403 (fail closed)', async () => {
    const db = buildDb({ clientAccounts: [{ id: CLIENT_A, tenantId: TENANT, userId: 'cust-1', deletedAt: null }] });
    const req = fakeReq(db, { currentUser: { id: 'cust-1', tenants: [{ tenant: { id: OTHER_TENANT }, status: 'active', roles: ['customer'] }] } });
    await assert.rejects(assertClientAccess(req, CLIENT_A), (e: any) => e.code === 403);
  });
});

// ══════════════════ fan-out cliente→CRM (clientAccountActivity) ══════════════
describe('op-clientes-sedes · clientAccountActivity (feed unificado cliente→CRM)', () => {
  afterEach(() => sinon.restore());

  it('customer accediendo a otro cliente → 403', async () => {
    const db = buildDb({ clientAccounts: [{ id: CLIENT_A, tenantId: TENANT, userId: 'otro', deletedAt: null }] });
    const req = fakeReq(db, { currentUser: customerUser(TENANT, 'cust-1'), params: { id: CLIENT_A }, query: {} });
    const res = fakeRes();
    await clientAccountActivity(req, res);
    assert.strictEqual(res.statusCode, 403);
  });

  it('cliente sin sedes ni estaciones → feed vacío (no cruza datos)', async () => {
    const db = buildDb({ clientAccounts: [{ id: CLIENT_A, tenantId: TENANT, deletedAt: null }] });
    const req = fakeReq(db, { params: { id: CLIENT_A }, query: {} });
    const res = fakeRes();
    await clientAccountActivity(req, res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.count, 0);
    assert.deepStrictEqual(res.body.rows, []);
  });

  it('mezcla turnos e incidentes de las sedes del cliente, ordenados desc', async () => {
    const now = Date.now();
    const recent = new Date(now - 2 * 86400000);
    const older = new Date(now - 5 * 86400000);
    const db = buildDb({
      clientAccounts: [{ id: CLIENT_A, tenantId: TENANT, deletedAt: null }],
      businessInfos: [{ id: 'bi-1', tenantId: TENANT, clientAccountId: CLIENT_A, companyName: 'Sede Centro', deletedAt: null }],
      stations: [{ id: 'st-1', tenantId: TENANT, postSiteId: 'bi-1', stationOriginId: CLIENT_A, stationName: 'Garita', deletedAt: null }],
      guardShifts: [{ id: 'gs-1', tenantId: TENANT, stationNameId: 'st-1', punchInTime: older, punchOutTime: null, guardNameId: 'g-1', deletedAt: null }],
      incidents: [{ id: 'inc-1', tenantId: TENANT, stationId: 'st-1', title: 'Alarma', priority: 'alta', createdAt: recent, deletedAt: null }],
    });
    const req = fakeReq(db, { params: { id: CLIENT_A }, query: {} });
    const res = fakeRes();
    await clientAccountActivity(req, res);

    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    const types = res.body.rows.map((r: any) => r.type);
    assert.ok(types.includes('clock_in'), 'debe incluir entrada de turno');
    assert.ok(types.includes('incident'), 'debe incluir incidente');
    // Orden descendente: el incidente reciente va antes que el turno más viejo.
    assert.strictEqual(res.body.rows[0].type, 'incident');
  });
});

// ═════════ mapeo commercialName (empresa) vs name/lastName (representante) ════
describe('op-clientes-sedes · mapeo empresa vs representante (clientAccount)', () => {
  beforeEach(() => {
    if ((AuditLogRepository as any).log?.restore) (AuditLogRepository as any).log.restore();
    sinon.stub(AuditLogRepository, 'log').resolves();
    if ((FileRepository as any).replaceRelationFiles?.restore) (FileRepository as any).replaceRelationFiles.restore();
    sinon.stub(FileRepository, 'replaceRelationFiles').resolves();
    if ((FileRepository as any).fillDownloadUrl?.restore) (FileRepository as any).fillDownloadUrl.restore();
    sinon.stub(FileRepository, 'fillDownloadUrl').resolves(null as any);
  });
  afterEach(() => sinon.restore());

  it('empresa (commercialName) y representante (name/lastName) se guardan en columnas distintas', async () => {
    const db = buildDb();
    await ClientAccountRepository.create(
      { name: 'Carlos', lastName: 'Pérez', commercialName: 'Constructora Andina S.A.', email: 'c@andina.ec', latitude: -0.18, longitude: -78.46 },
      repoOptions(db),
    );
    const w = db.clientAccount.calls.create[0];
    assert.strictEqual(w.commercialName, 'Constructora Andina S.A.', 'empresa en commercialName');
    assert.strictEqual(w.name, 'Carlos', 'representante (nombre) en name — no lo pisa commercialName');
    assert.strictEqual(w.lastName, 'Pérez', 'representante (apellido) en lastName');
  });

  it('sin representante, name cae al commercialName (fallback empresa)', async () => {
    const db = buildDb();
    await ClientAccountRepository.create(
      { commercialName: 'Solo Empresa S.A.', email: 'e@x.ec', latitude: -0.18, longitude: -78.46 },
      repoOptions(db),
    );
    assert.strictEqual(db.clientAccount.calls.create[0].name, 'Solo Empresa S.A.');
  });
});
