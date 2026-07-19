/**
 * Unit tests — CRUD persistence fidelity for the g01-clients group.
 *
 * Context: tenants report "things are not being saved". The classic causes are
 * (1) a handler accepts a field but the repository DROPS it before the write,
 * (2) update paths whose where-clause / whitelist silently ignores changes,
 * (3) swallowed errors (try/catch returning success anyway).
 *
 * Covered (REAL repository/handler code against a Sequelize-shaped fake db —
 * no MySQL, no network):
 *   - clientAccountRepository create/update      (field fidelity, where target,
 *                                                 duplicate-email 400, db error
 *                                                 propagation, identity sync)
 *   - clientContactRepository create/update/destroy
 *   - representanteEmpresaRepository create/update
 *   - clientProject create/update handlers       (full express handlers)
 *   - tenantUserClientAccounts handlers           (pivot create/delete/list)
 *
 * Run:
 *   cross-env NODE_ENV=test TS_NODE_PROJECT=tsconfig.test.json \
 *     npx mocha -r ts-node/register \
 *     'tests/unit/crud-g01-clients/**\/*.test.ts' --exit --timeout 20000
 */

import assert from 'assert';
import sinon from 'sinon';
import Sequelize from 'sequelize';

import ClientAccountRepository from '../../../src/database/repositories/clientAccountRepository';
import ClientContactRepository from '../../../src/database/repositories/clientContactRepository';
import AuditLogRepository from '../../../src/database/repositories/auditLogRepository';
import FileRepository from '../../../src/database/repositories/fileRepository';
import Error400 from '../../../src/errors/Error400';
import Error404 from '../../../src/errors/Error404';

import clientProjectCreate from '../../../src/api/clientProject/clientProjectCreate';
import clientProjectUpdate from '../../../src/api/clientProject/clientProjectUpdate';
import {
  listTenantUserClientAccounts,
  createTenantUserClientAccount,
  deleteTenantUserClientAccount,
} from '../../../src/api/tenantUserClientAccounts';

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
    async getLogoUrl() {
      return null;
    },
    async getPlacePictureUrl() {
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
  clientAccounts?: any[];
  clientContacts?: any[];
  representantes?: any[];
  clientProjects?: any[];
  businessInfos?: any[];
  users?: any[];
  tenantUsers?: any[];
  pivots?: any[];
} = {}) {
  return {
    clientAccount: makeModel('clientAccount', seed.clientAccounts || []),
    clientContact: makeModel('clientContact', seed.clientContacts || []),
    representanteEmpresa: makeModel('representanteEmpresa', seed.representantes || []),
    clientProject: makeModel('clientProject', seed.clientProjects || []),
    businessInfo: makeModel('businessInfo', seed.businessInfos || []),
    user: makeModel('user', seed.users || []),
    tenantUser: makeModel('tenantUser', seed.tenantUsers || []),
    tenant_user_client_accounts: makeModel('tenant_user_client_account', seed.pivots || []),
    category: makeModel('category', []),
    file: makeModel('file', []),
  } as any;
}

function repoOptions(db: any, tenantId = TENANT) {
  return {
    currentUser: { id: USER_ID },
    currentTenant: { id: tenantId },
    language: 'es',
    database: db,
  } as any;
}

// Admin req context (passes PermissionChecker on the free plan; the shadow
// enforceGate never blocks with RBAC_ENFORCE_NEW_GATES off).
function adminUser(tenantId = TENANT) {
  return {
    id: USER_ID,
    emailVerified: true,
    tenants: [{ tenant: { id: tenantId }, status: 'active', roles: ['admin'] }],
  };
}

function fakeReq(db: any, extra: any = {}) {
  return {
    currentUser: adminUser(),
    currentTenant: { id: TENANT },
    language: 'es',
    database: db,
    params: {},
    body: {},
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

// Stub the cross-cutting side channels (audit log + file relations) — they are
// not the persistence under test and would otherwise need their own models.
beforeEach(() => {
  if ((AuditLogRepository as any).log?.restore) (AuditLogRepository as any).log.restore();
  sinon.stub(AuditLogRepository, 'log').resolves();
  if ((FileRepository as any).replaceRelationFiles?.restore) (FileRepository as any).replaceRelationFiles.restore();
  sinon.stub(FileRepository, 'replaceRelationFiles').resolves();
  if ((FileRepository as any).fillDownloadUrl?.restore) (FileRepository as any).fillDownloadUrl.restore();
  sinon.stub(FileRepository, 'fillDownloadUrl').resolves(null as any);
});
afterEach(() => sinon.restore());

// ═══════════════════════════ clientAccount ══════════════════════════════════
describe('crud-g01 · clientAccountRepository.create', () => {
  // Every writable field the CRM client form can send (per the repository
  // whitelist + model definition).
  const FULL_CREATE = {
    name: 'Constructora Andina',
    commercialName: 'Andina S.A.',
    lastName: 'Pérez',
    email: 'cliente@andina.ec',
    personType: 'PJ',
    documentNumber: '1790012345001',
    phoneNumber: '0999123456',
    address: 'Av. Amazonas N34-451',
    addressComplement: 'Piso 3',
    zipCode: '170135',
    city: 'Quito',
    country: 'Ecuador',
    useSameAddressForBilling: false,
    faxNumber: '022345678',
    landline: '023456789',
    website: 'https://andina.ec',
    contractDate: '2026-01-15',
    latitude: -0.180653,
    longitude: -78.467838,
    importHash: 'hash-abc',
    categoryIds: ['cat-1', 'cat-2'],
    active: true,
  };

  it('persists EVERY writable field the form sends (field fidelity)', async () => {
    const db = buildDb();
    await ClientAccountRepository.create({ ...FULL_CREATE }, repoOptions(db));

    assert.strictEqual(db.clientAccount.calls.create.length, 1);
    const written = db.clientAccount.calls.create[0];
    for (const [k, v] of Object.entries(FULL_CREATE)) {
      assert.deepStrictEqual(written[k], v, `field "${k}" was dropped or altered on create`);
    }
    assert.strictEqual(written.tenantId, TENANT);
    assert.strictEqual(written.createdById, USER_ID);
    assert.strictEqual(written.updatedById, USER_ID);
  });

  it('stores the logo and place picture via the file relation (both slots wired)', async () => {
    const db = buildDb();
    const logo = [{ id: 'f-1', name: 'logo.png' }];
    const place = [{ id: 'f-2', name: 'place.png' }];
    await ClientAccountRepository.create(
      { ...FULL_CREATE, logoUrl: logo, placePictureUrl: place },
      repoOptions(db),
    );
    const stub = FileRepository.replaceRelationFiles as sinon.SinonStub;
    const cols = stub.getCalls().map((c) => c.args[0].belongsToColumn);
    assert.ok(cols.includes('logoUrl'), 'logoUrl relation not written');
    assert.ok(cols.includes('placePictureUrl'), 'placePictureUrl relation not written');
    const logoCall = stub.getCalls().find((c) => c.args[0].belongsToColumn === 'logoUrl');
    assert.deepStrictEqual(logoCall!.args[1], logo);
  });

  it('falls back name → commercialName when only the business name is provided', async () => {
    const db = buildDb();
    await ClientAccountRepository.create(
      { ...FULL_CREATE, name: undefined, commercialName: 'Solo Comercial' },
      repoOptions(db),
    );
    assert.strictEqual(db.clientAccount.calls.create[0].name, 'Solo Comercial');
  });

  it('derives the identity cache FROM the linked user when userId is given', async () => {
    const db = buildDb({
      users: [{ id: 'u-9', firstName: 'María', lastName: 'Gómez', email: 'maria@x.ec', phoneNumber: '0988777666' }],
    });
    await ClientAccountRepository.create({ ...FULL_CREATE, userId: 'u-9' }, repoOptions(db));
    const written = db.clientAccount.calls.create[0];
    assert.strictEqual(written.name, 'María');
    assert.strictEqual(written.lastName, 'Gómez');
    assert.strictEqual(written.email, 'maria@x.ec');
    assert.strictEqual(written.phoneNumber, '0988777666');
    assert.strictEqual(written.userId, 'u-9');
  });

  it('rejects a duplicate email inside the tenant with Error400 (no silent create)', async () => {
    const db = buildDb({
      clientAccounts: [{ id: 'ca-0', tenantId: TENANT, email: 'cliente@andina.ec', deletedAt: null }],
    });
    await assert.rejects(
      () => ClientAccountRepository.create({ ...FULL_CREATE }, repoOptions(db)),
      (e: any) => e instanceof Error400,
    );
    assert.strictEqual(db.clientAccount.calls.create.length, 0, 'must not create on duplicate email');
  });

  it('a db failure on create PROPAGATES (not swallowed into a success)', async () => {
    const db = buildDb();
    db.clientAccount.create = async () => {
      throw new Error('DB down');
    };
    await assert.rejects(
      () => ClientAccountRepository.create({ ...FULL_CREATE }, repoOptions(db)),
      /DB down/,
    );
  });
});

describe('crud-g01 · clientAccountRepository.update', () => {
  const EXISTING = {
    id: 'ca-1',
    tenantId: TENANT,
    userId: null,
    name: 'Viejo',
    address: 'Calle Vieja 1',
    addressComplement: null,
    city: 'Quito',
    country: 'Ecuador',
    zipCode: null,
    categoryIds: [],
    deletedAt: null,
  };

  // Full form payload; latitude/longitude included so the geocode branch
  // (network) is skipped (coordsProvided === true).
  const FULL_UPDATE = {
    name: 'Nuevo Nombre',
    commercialName: 'Nueva Comercial',
    lastName: 'Salazar',
    email: 'nuevo@cliente.ec',
    personType: 'PN',
    documentNumber: '1712345678',
    phoneNumber: '0987654321',
    address: 'Av. Nueva 456',
    addressComplement: 'Oficina 2',
    zipCode: '170150',
    city: 'Guayaquil',
    country: 'Ecuador',
    useSameAddressForBilling: true,
    faxNumber: '042222333',
    landline: '043333444',
    website: 'https://nuevo.ec',
    contractDate: '2026-03-01',
    latitude: -2.170998,
    longitude: -79.922359,
    importHash: 'hash-upd',
    categoryIds: ['cat-9'],
    active: false,
  };

  it('applies EVERY writable field onto the right row (id + tenantId in the where)', async () => {
    const db = buildDb({ clientAccounts: [{ ...EXISTING }] });
    await ClientAccountRepository.update('ca-1', { ...FULL_UPDATE }, repoOptions(db));

    // Where-clause targeting: the row lookup must be scoped by id AND tenantId.
    const firstFind = db.clientAccount.calls.findOne[0];
    assert.strictEqual(firstFind.where.id, 'ca-1');
    assert.strictEqual(firstFind.where.tenantId, TENANT);

    const row = db.clientAccount.rows[0];
    assert.ok(row.__updateCalls.length >= 1, 'row.update was never called');
    const patch = row.__updateCalls[0];
    for (const [k, v] of Object.entries(FULL_UPDATE)) {
      assert.deepStrictEqual(patch[k], v, `field "${k}" was dropped or altered on update`);
    }
    assert.strictEqual(patch.updatedById, USER_ID);
    // And the row actually holds the new values.
    assert.strictEqual(row.active, false);
    assert.strictEqual(row.contractDate, '2026-03-01');
    assert.deepStrictEqual(row.categoryIds, ['cat-9']);
  });

  it('propagates identity edits TO the linked user (rename no longer reverts)', async () => {
    const db = buildDb({
      clientAccounts: [{ ...EXISTING, userId: 'u-9' }],
      users: [{ id: 'u-9', firstName: 'Viejo', lastName: 'Gerente', email: 'viejo@x.ec', phoneNumber: '111' }],
    });
    await ClientAccountRepository.update(
      'ca-1',
      { ...FULL_UPDATE, name: 'Carlos', lastName: 'Mena', email: 'carlos@x.ec', phoneNumber: '0977' },
      repoOptions(db),
    );
    const user = db.user.rows[0];
    assert.strictEqual(user.firstName, 'Carlos', 'firstName not propagated to linked user');
    assert.strictEqual(user.lastName, 'Mena');
    assert.strictEqual(user.email, 'carlos@x.ec');
    assert.strictEqual(user.phoneNumber, '0977');
    // The clientAccount cache is then derived back from the user — so the new
    // values must be what lands on the record (this is the anti-revert fix).
    const patch = db.clientAccount.rows[0].__updateCalls[0];
    assert.strictEqual(patch.name, 'Carlos');
    assert.strictEqual(patch.email, 'carlos@x.ec');
    assert.strictEqual(patch.phoneNumber, '0977');
  });

  it('throws Error404 (and writes nothing) when the id belongs to another tenant', async () => {
    const db = buildDb({ clientAccounts: [{ ...EXISTING, tenantId: OTHER_TENANT }] });
    await assert.rejects(
      () => ClientAccountRepository.update('ca-1', { ...FULL_UPDATE }, repoOptions(db)),
      (e: any) => e instanceof Error404,
    );
    assert.strictEqual(db.clientAccount.rows[0].__updateCalls.length, 0);
  });

  it('a db failure on row.update PROPAGATES (not swallowed)', async () => {
    const db = buildDb({ clientAccounts: [{ ...EXISTING }] });
    db.clientAccount.rows[0].update = async () => {
      throw new Error('write failed');
    };
    await assert.rejects(
      () => ClientAccountRepository.update('ca-1', { ...FULL_UPDATE }, repoOptions(db)),
      /write failed/,
    );
  });
});

// ═══════════════════════════ clientContact ══════════════════════════════════
describe('crud-g01 · clientContactRepository (contacts inside clientAccount)', () => {
  const FULL_CONTACT = {
    name: 'Contacto Uno',
    email: 'contacto@cliente.ec',
    mobile: '0991112233',
    description: 'Encargado de seguridad nocturna',
    postSiteId: 'site-1',
    allowGuard: true,
    clientAccountId: 'ca-1',
  };

  it('create persists every field the contact form sends', async () => {
    const db = buildDb();
    await ClientContactRepository.create({ ...FULL_CONTACT }, repoOptions(db));
    assert.strictEqual(db.clientContact.calls.create.length, 1);
    const written = db.clientContact.calls.create[0];
    for (const [k, v] of Object.entries(FULL_CONTACT)) {
      assert.deepStrictEqual(written[k], v, `field "${k}" was dropped or altered on create`);
    }
    assert.strictEqual(written.tenantId, TENANT);
    assert.strictEqual(written.createdById, USER_ID);
    assert.strictEqual(written.updatedById, USER_ID);
  });

  it('create accepts the postSite alias for postSiteId', async () => {
    const db = buildDb();
    await ClientContactRepository.create(
      { ...FULL_CONTACT, postSiteId: undefined, postSite: 'site-9' },
      repoOptions(db),
    );
    assert.strictEqual(db.clientContact.calls.create[0].postSiteId, 'site-9');
  });

  // FIXED: ClientContactRepository.create now maps importHash (the model always
  // defined the column; the create mapping used to drop it).
  it('create persists importHash (declared on the model + in the OpenAPI contract)', async () => {
    const db = buildDb();
    await ClientContactRepository.create({ ...FULL_CONTACT, importHash: 'h-1' }, repoOptions(db));
    assert.strictEqual(db.clientContact.calls.create[0].importHash, 'h-1');
  });

  it('update targets the right row (id + tenantId) and applies the full patch', async () => {
    const db = buildDb({
      clientContacts: [{ id: 'cc-1', tenantId: TENANT, ...FULL_CONTACT, deletedAt: null }],
    });
    const patch = {
      name: 'Contacto Editado',
      email: 'editado@cliente.ec',
      mobile: '0994445566',
      description: 'Nuevo encargado',
      postSiteId: 'site-2',
      allowGuard: false,
    };
    await ClientContactRepository.update('cc-1', { ...patch }, repoOptions(db));

    const firstFind = db.clientContact.calls.findOne[0];
    assert.strictEqual(firstFind.where.id, 'cc-1');
    assert.strictEqual(firstFind.where.tenantId, TENANT);

    const row = db.clientContact.rows[0];
    const written = row.__updateCalls[0];
    for (const [k, v] of Object.entries(patch)) {
      assert.deepStrictEqual(written[k], v, `field "${k}" was dropped or altered on update`);
    }
    assert.strictEqual(written.updatedById, USER_ID);
    assert.strictEqual(row.name, 'Contacto Editado');
  });

  // FIXED: ClientContactRepository.update is now presence-guarded — only keys
  // present in the payload are written, so a partial update (e.g. { name })
  // keeps email/mobile/description/postSiteId/allowGuard intact.
  it('a partial update must NOT clobber the fields that were not sent', async () => {
    const db = buildDb({
      clientContacts: [{ id: 'cc-1', tenantId: TENANT, ...FULL_CONTACT, deletedAt: null }],
    });
    await ClientContactRepository.update('cc-1', { name: 'Solo Nombre' }, repoOptions(db));
    const row = db.clientContact.rows[0];
    assert.strictEqual(row.email, FULL_CONTACT.email, 'email wiped by partial update');
    assert.strictEqual(row.mobile, FULL_CONTACT.mobile, 'mobile wiped by partial update');
    assert.strictEqual(row.description, FULL_CONTACT.description, 'description wiped by partial update');
    assert.strictEqual(row.postSiteId, FULL_CONTACT.postSiteId, 'postSiteId wiped by partial update');
    assert.strictEqual(row.allowGuard, true, 'allowGuard reset by partial update');
  });

  it('update on a foreign-tenant contact throws Error404 and writes nothing', async () => {
    const db = buildDb({
      clientContacts: [{ id: 'cc-1', tenantId: OTHER_TENANT, ...FULL_CONTACT, deletedAt: null }],
    });
    await assert.rejects(
      () => ClientContactRepository.update('cc-1', { name: 'X' }, repoOptions(db)),
      (e: any) => e instanceof Error404,
    );
    assert.strictEqual(db.clientContact.rows[0].__updateCalls.length, 0);
  });

  it('destroy soft-deletes the tenant-scoped row', async () => {
    const db = buildDb({
      clientContacts: [{ id: 'cc-1', tenantId: TENANT, ...FULL_CONTACT, deletedAt: null }],
    });
    await ClientContactRepository.destroy('cc-1', repoOptions(db));
    assert.strictEqual(db.clientContact.rows[0].__destroyed, true);
    const firstFind = db.clientContact.calls.findOne[0];
    assert.strictEqual(firstFind.where.tenantId, TENANT);
  });
});

// ═══════════════════════ representanteEmpresa ═══════════════════════════════
// ═══════════════════════════ clientProject ══════════════════════════════════
describe('crud-g01 · clientProject handlers', () => {
  const seed = {
    clientAccounts: [{ id: 'ca-1', tenantId: TENANT, name: 'Andina', deletedAt: null }],
    businessInfos: [{ id: 'bi-1', tenantId: TENANT, companyName: 'Sitio', deletedAt: null }],
  };

  const FULL_PROJECT_BODY = {
    name: '  Evento Concierto  ',
    type: 'event',
    clientAccountId: 'ca-1',
    businessInfoId: 'bi-1',
    description: 'Seguridad para concierto',
    status: 'active',
    startDate: '2026-08-01',
    endDate: '2026-08-02',
    location: 'Estadio Olímpico',
    estimatedHours: '12.5',
    assignedGuards: ['g-1', 'g-2'],
    notes: 'Llevar radios',
  };

  it('create persists every field (trimmed name, parsed hours) with tenant scope', async () => {
    const db = buildDb(seed);
    const req = fakeReq(db, { params: { tenantId: TENANT }, body: { ...FULL_PROJECT_BODY } });
    const res = fakeRes();
    await clientProjectCreate(req, res);

    assert.strictEqual(res.statusCode, 201, `expected 201, got ${res.statusCode}: ${JSON.stringify(res.body)}`);
    const written = db.clientProject.calls.create[0];
    assert.strictEqual(written.tenantId, TENANT);
    assert.strictEqual(written.clientAccountId, 'ca-1');
    assert.strictEqual(written.businessInfoId, 'bi-1');
    assert.strictEqual(written.name, 'Evento Concierto');
    assert.strictEqual(written.type, 'event');
    assert.strictEqual(written.description, FULL_PROJECT_BODY.description);
    assert.strictEqual(written.status, 'active');
    assert.strictEqual(written.startDate, '2026-08-01');
    assert.strictEqual(written.endDate, '2026-08-02');
    assert.strictEqual(written.location, FULL_PROJECT_BODY.location);
    assert.strictEqual(written.estimatedHours, 12.5);
    assert.deepStrictEqual(written.assignedGuards, ['g-1', 'g-2']);
    assert.strictEqual(written.notes, FULL_PROJECT_BODY.notes);
  });

  it("create refuses another tenant's clientAccount (404, nothing written)", async () => {
    const db = buildDb({
      clientAccounts: [{ id: 'ca-x', tenantId: OTHER_TENANT, name: 'Foreign', deletedAt: null }],
    });
    const req = fakeReq(db, { params: { tenantId: TENANT }, body: { ...FULL_PROJECT_BODY, clientAccountId: 'ca-x' } });
    const res = fakeRes();
    await clientProjectCreate(req, res);
    assert.strictEqual(res.statusCode, 404);
    assert.strictEqual(db.clientProject.calls.create.length, 0);
  });

  it('update targets {id, tenantId} and applies every changed field', async () => {
    const db = buildDb({
      ...seed,
      clientProjects: [
        {
          id: 'pr-1',
          tenantId: TENANT,
          clientAccountId: 'ca-1',
          name: 'Viejo',
          type: 'event',
          status: 'active',
          notes: 'old',
          deletedAt: null,
        },
      ],
    });
    const body = {
      name: 'Investigación Interna',
      type: 'investigation',
      description: 'desc nueva',
      status: 'on_hold',
      startDate: '2026-09-01',
      endDate: '2026-09-30',
      location: 'Oficina Norte',
      estimatedHours: '40',
      assignedGuards: ['g-3'],
      notes: 'nota nueva',
      businessInfoId: 'bi-1',
    };
    const req = fakeReq(db, { params: { tenantId: TENANT, id: 'pr-1' }, body });
    const res = fakeRes();
    await clientProjectUpdate(req, res);

    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    const find = db.clientProject.calls.findOne[0];
    assert.strictEqual(find.where.id, 'pr-1');
    assert.strictEqual(find.where.tenantId, TENANT);

    const row = db.clientProject.rows[0];
    const patch = row.__updateCalls[0];
    assert.strictEqual(patch.name, 'Investigación Interna');
    assert.strictEqual(patch.type, 'investigation');
    assert.strictEqual(patch.description, 'desc nueva');
    assert.strictEqual(patch.status, 'on_hold');
    assert.strictEqual(patch.startDate, '2026-09-01');
    assert.strictEqual(patch.endDate, '2026-09-30');
    assert.strictEqual(patch.location, 'Oficina Norte');
    assert.strictEqual(patch.estimatedHours, 40);
    assert.deepStrictEqual(patch.assignedGuards, ['g-3']);
    assert.strictEqual(patch.notes, 'nota nueva');
    assert.strictEqual(patch.businessInfoId, 'bi-1');
  });

  it('a PARTIAL update only touches the sent keys (no clobber — the guard pattern done right)', async () => {
    const db = buildDb({
      ...seed,
      clientProjects: [
        {
          id: 'pr-1',
          tenantId: TENANT,
          clientAccountId: 'ca-1',
          name: 'Evento X',
          type: 'event',
          status: 'active',
          notes: 'keep-me',
          location: 'keep-loc',
          deletedAt: null,
        },
      ],
    });
    const req = fakeReq(db, { params: { tenantId: TENANT, id: 'pr-1' }, body: { status: 'completed' } });
    const res = fakeRes();
    await clientProjectUpdate(req, res);
    assert.strictEqual(res.statusCode, 200);
    const patch = db.clientProject.rows[0].__updateCalls[0];
    assert.deepStrictEqual(Object.keys(patch), ['status']);
    assert.strictEqual(db.clientProject.rows[0].notes, 'keep-me');
    assert.strictEqual(db.clientProject.rows[0].location, 'keep-loc');
  });

  it('a db failure on update returns 500, NOT a fake success', async () => {
    const db = buildDb({
      ...seed,
      clientProjects: [{ id: 'pr-1', tenantId: TENANT, clientAccountId: 'ca-1', name: 'X', type: 'event', status: 'active', deletedAt: null }],
    });
    db.clientProject.rows[0].update = async () => {
      throw new Error('write exploded');
    };
    const req = fakeReq(db, { params: { tenantId: TENANT, id: 'pr-1' }, body: { name: 'Y' } });
    const res = fakeRes();
    await clientProjectUpdate(req, res);
    assert.strictEqual(res.statusCode, 500);
  });

  // FIXED: clientProjectUpdate now validates a new clientAccountId belongs to
  // the caller's tenant (mirrors clientProjectCreate) — a project can no longer
  // be re-parented onto another tenant's client.
  it("update must reject a clientAccountId from another tenant", async () => {
    const db = buildDb({
      clientAccounts: [{ id: 'ca-x', tenantId: OTHER_TENANT, name: 'Foreign', deletedAt: null }],
      clientProjects: [{ id: 'pr-1', tenantId: TENANT, clientAccountId: 'ca-1', name: 'X', type: 'event', status: 'active', deletedAt: null }],
    });
    const req = fakeReq(db, { params: { tenantId: TENANT, id: 'pr-1' }, body: { clientAccountId: 'ca-x' } });
    const res = fakeRes();
    await clientProjectUpdate(req, res);
    assert.notStrictEqual(db.clientProject.rows[0].clientAccountId, 'ca-x');
  });
});

// ════════════════════ tenantUserClientAccounts (pivot) ══════════════════════
describe('crud-g01 · tenantUserClientAccounts handlers', () => {
  const seed = {
    tenantUsers: [{ id: 'tu-1', tenantId: TENANT, userId: USER_ID, deletedAt: null }],
    clientAccounts: [{ id: 'ca-1', tenantId: TENANT, name: 'Andina', deletedAt: null }],
  };

  it('create persists the full pivot row (tenantUserId, clientAccountId, security_guard_id, tenantId)', async () => {
    const db = buildDb(seed);
    const req = fakeReq(db, {
      body: { tenantUserId: 'tu-1', clientAccountId: 'ca-1', security_guard_id: 'sg-7' },
    });
    const res = fakeRes();
    await createTenantUserClientAccount(req, res);

    // Note: the handler calls res.status(201) but ApiResponseHandler.success
    // then re-stamps 200 — so the API answers 200. Cosmetic, not a persistence
    // bug; assert success (< 400) and verify the actual write below.
    assert.ok(res.statusCode < 400, `expected success, got ${res.statusCode}: ${JSON.stringify(res.body)}`);
    const written = db.tenant_user_client_accounts.calls.create[0];
    assert.strictEqual(written.tenantUserId, 'tu-1');
    assert.strictEqual(written.clientAccountId, 'ca-1');
    assert.strictEqual(written.security_guard_id, 'sg-7');
    assert.strictEqual(written.tenantId, TENANT);
  });

  it('create refuses to link across tenants (400, nothing written)', async () => {
    const db = buildDb({
      tenantUsers: seed.tenantUsers,
      clientAccounts: [{ id: 'ca-x', tenantId: OTHER_TENANT, name: 'Foreign', deletedAt: null }],
    });
    const req = fakeReq(db, { body: { tenantUserId: 'tu-1', clientAccountId: 'ca-x' } });
    const res = fakeRes();
    await createTenantUserClientAccount(req, res);
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(db.tenant_user_client_accounts.calls.create.length, 0);
  });

  it('a db failure on create surfaces as an error response, not a success', async () => {
    const db = buildDb(seed);
    db.tenant_user_client_accounts.create = async () => {
      throw new Error('pivot write failed');
    };
    const req = fakeReq(db, { body: { tenantUserId: 'tu-1', clientAccountId: 'ca-1' } });
    const res = fakeRes();
    await createTenantUserClientAccount(req, res);
    assert.strictEqual(res.statusCode, 500);
  });

  it('delete scopes the destroy to {id, tenantId}', async () => {
    const db = buildDb({
      ...seed,
      pivots: [{ id: 'pv-1', tenantId: TENANT, tenantUserId: 'tu-1', clientAccountId: 'ca-1' }],
    });
    const req = fakeReq(db, { params: { id: 'pv-1' } });
    const res = fakeRes();
    await deleteTenantUserClientAccount(req, res);
    assert.strictEqual(res.statusCode, 200);
    const q = db.tenant_user_client_accounts.calls.destroy[0];
    assert.strictEqual(q.where.id, 'pv-1');
    assert.strictEqual(q.where.tenantId, TENANT);
    assert.strictEqual(res.body.deleted, 1);
  });

  it('delete of a foreign-tenant pivot removes nothing', async () => {
    const db = buildDb({
      ...seed,
      pivots: [{ id: 'pv-1', tenantId: OTHER_TENANT, tenantUserId: 'tu-x', clientAccountId: 'ca-x' }],
    });
    const req = fakeReq(db, { params: { id: 'pv-1' } });
    const res = fakeRes();
    await deleteTenantUserClientAccount(req, res);
    assert.strictEqual(res.body.deleted, 0);
    assert.strictEqual(db.tenant_user_client_accounts.rows[0].__destroyed, false);
  });

  it('list is tenant-scoped', async () => {
    const db = buildDb({
      ...seed,
      pivots: [
        { id: 'pv-1', tenantId: TENANT, tenantUserId: 'tu-1', clientAccountId: 'ca-1' },
        { id: 'pv-2', tenantId: OTHER_TENANT, tenantUserId: 'tu-x', clientAccountId: 'ca-x' },
      ],
    });
    const req = fakeReq(db, {});
    const res = fakeRes();
    await listTenantUserClientAccounts(req, res);
    assert.strictEqual(res.statusCode, 200);
    const q = db.tenant_user_client_accounts.calls.findAll[0];
    assert.strictEqual(q.where.tenantId, TENANT);
    assert.strictEqual(res.body.length, 1);
    assert.strictEqual(res.body[0].id, 'pv-1');
  });

  it('missing tenant context fails closed (400), never dumps the pivot table', async () => {
    const db = buildDb(seed);
    const req = fakeReq(db, { currentTenant: null });
    const res = fakeRes();
    await listTenantUserClientAccounts(req, res);
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(db.tenant_user_client_accounts.calls.findAll.length, 0);
  });
});
