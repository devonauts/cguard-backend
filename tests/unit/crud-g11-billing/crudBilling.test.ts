/**
 * Unit tests — CRUD persistence fidelity for the g11-billing group.
 *
 * Context: tenants report "things are not being saved". The classic causes are
 * (1) a handler accepts a field but the repository DROPS it before the write,
 * (2) update paths whose where-clause / whitelist silently ignores changes,
 * (3) swallowed errors (try/catch returning success anyway).
 *
 * Covered (REAL repository/service code against a Sequelize-shaped fake db —
 * no MySQL, no network):
 *   - billingRepository create/update/destroy + billingService (field fidelity,
 *     where target, tenant scoping, error propagation, partial-update clobber)
 *   - invoiceRepository create/update + invoiceService (auto invoiceNumber,
 *     partial-update guard, referenceEstimateId drop, error propagation)
 *   - estimateRepository create/update + estimateService (auto estimateNumber,
 *     convert → invoice, send() status patch, partial-update clobber)
 *   - taxRepository create/update/destroy + taxService (duplicate-name 400,
 *     tenant scoping, swallowed dup-check errors)
 *   - paymentService.create (append to invoice.payments, over-total gate,
 *     rollback on failure)
 *
 * NOT covered (see modulesSkipped): payroll (read-only, no DB writes — engine
 * already covered by tests/unit/payroll), plan + subscription (Stripe network
 * flows, covered by tests/unit/platform-billing).
 *
 * Run:
 *   cross-env NODE_ENV=test TS_NODE_PROJECT=tsconfig.test.json \
 *     npx mocha -r ts-node/register \
 *     'tests/unit/crud-g11-billing/**\/*.test.ts' --exit --timeout 20000
 */

import assert from 'assert';
import sinon from 'sinon';
import Sequelize from 'sequelize';

import BillingRepository from '../../../src/database/repositories/billingRepository';
import InvoiceRepository from '../../../src/database/repositories/invoiceRepository';
import EstimateRepository from '../../../src/database/repositories/estimateRepository';
import TaxRepository from '../../../src/database/repositories/taxRepository';
import AuditLogRepository from '../../../src/database/repositories/auditLogRepository';
import FileRepository from '../../../src/database/repositories/fileRepository';
import Error400 from '../../../src/errors/Error400';
import Error404 from '../../../src/errors/Error404';

import BillingService from '../../../src/services/billingService';
import InvoiceService from '../../../src/services/invoiceService';
import EstimateService from '../../../src/services/estimateService';
import TaxService from '../../../src/services/taxService';
import PaymentService from '../../../src/services/paymentService';

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
    // billing.findById → _fillWithRelationsAndFiles → record.getBill()
    async getBill() {
      return null;
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
    async count(q: any = {}) {
      return model.rows.filter((r: any) => !r.__destroyed && matchWhere(r, q.where)).length;
    },
    async findAndCountAll(q: any = {}) {
      const rows = model.rows.filter((r: any) => !r.__destroyed && matchWhere(r, q.where));
      return { rows, count: rows.length };
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
  billings?: any[];
  invoices?: any[];
  estimates?: any[];
  taxes?: any[];
  clientAccounts?: any[];
  businessInfos?: any[];
} = {}) {
  const businessInfo = makeModel('businessInfo', seed.businessInfos || []);
  const db: any = {
    billing: makeModel('billing', seed.billings || []),
    invoice: makeModel('invoice', seed.invoices || []),
    estimate: makeModel('estimate', seed.estimates || []),
    tax: makeModel('tax', seed.taxes || []),
    clientAccount: makeModel('clientAccount', seed.clientAccounts || []),
    businessInfo,
    postSite: businessInfo, // alias, same as models/index.ts
    user: makeModel('user', []),
    file: makeModel('file', []),
    category: makeModel('category', []),
  };
  // Transaction plumbing used by the services (SequelizeRepository.createTransaction
  // → database.sequelize.transaction(); paymentService uses transaction.LOCK.UPDATE).
  db.__tx = { commits: 0, rollbacks: 0 };
  db.sequelize = {
    QueryTypes: { SELECT: 'SELECT' },
    __queryResults: [{ max: 0 }],
    async transaction() {
      return {
        LOCK: { UPDATE: 'UPDATE' },
        async commit() {
          db.__tx.commits += 1;
        },
        async rollback() {
          db.__tx.rollbacks += 1;
        },
      };
    },
    async query() {
      return db.sequelize.__queryResults;
    },
  };
  return db;
}

function repoOptions(db: any, tenantId = TENANT) {
  return {
    currentUser: { id: USER_ID },
    currentTenant: { id: tenantId },
    language: 'es',
    database: db,
  } as any;
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

// ═══════════════════════════════ billing ════════════════════════════════════
describe('crud-g11 · billingRepository.create', () => {
  // Every writable field the CRM Facturación form can send (repository
  // whitelist + model definition in src/database/models/billing.ts).
  const FULL_CREATE = {
    invoiceNumber: 'FB-0001',
    status: 'Pendiente',
    montoPorPagar: 1234.56,
    lastPaymentDate: '2026-06-01',
    nextPaymentDate: '2026-08-01',
    description: 'Servicio de guardianía junio',
    importHash: 'bill-hash-1',
  };

  it('persists EVERY writable field the form sends (field fidelity)', async () => {
    const db = buildDb();
    await BillingRepository.create(
      { ...FULL_CREATE, clientsInvoiced: 'ca-1' },
      repoOptions(db),
    );

    assert.strictEqual(db.billing.calls.create.length, 1);
    const written = db.billing.calls.create[0];
    for (const [k, v] of Object.entries(FULL_CREATE)) {
      assert.deepStrictEqual(written[k], v, `field "${k}" was dropped or altered on create`);
    }
    assert.strictEqual(written.clientsInvoicedId, 'ca-1');
    assert.strictEqual(written.tenantId, TENANT);
    assert.strictEqual(written.createdById, USER_ID);
    assert.strictEqual(written.updatedById, USER_ID);
  });

  it('stores the attached bill file via the file relation', async () => {
    const db = buildDb();
    const bill = [{ id: 'f-1', name: 'factura.pdf' }];
    await BillingRepository.create({ ...FULL_CREATE, bill }, repoOptions(db));
    const stub = FileRepository.replaceRelationFiles as sinon.SinonStub;
    const call = stub.getCalls().find((c) => c.args[0].belongsToColumn === 'bill');
    assert.ok(call, 'bill file relation not written');
    assert.deepStrictEqual(call!.args[1], bill);
  });

  it('a db failure on create PROPAGATES through the service (rollback, no fake success)', async () => {
    const db = buildDb();
    db.billing.create = async () => {
      throw new Error('DB down');
    };
    await assert.rejects(
      () => new BillingService(repoOptions(db)).create({ ...FULL_CREATE }),
      /DB down/,
    );
    assert.strictEqual(db.__tx.rollbacks, 1, 'transaction must be rolled back');
    assert.strictEqual(db.__tx.commits, 0);
  });

  it("service maps a foreign tenant's clientsInvoiced to null (never links cross-tenant)", async () => {
    const db = buildDb({
      clientAccounts: [{ id: 'ca-x', tenantId: OTHER_TENANT, name: 'Foreign', deletedAt: null }],
    });
    await new BillingService(repoOptions(db)).create({ ...FULL_CREATE, clientsInvoiced: 'ca-x' });
    assert.strictEqual(db.billing.calls.create[0].clientsInvoicedId, null);
    assert.strictEqual(db.__tx.commits, 1);
  });
});

describe('crud-g11 · billingRepository.update', () => {
  const EXISTING = {
    id: 'bl-1',
    tenantId: TENANT,
    invoiceNumber: 'FB-0001',
    status: 'Pendiente',
    montoPorPagar: 100,
    lastPaymentDate: null,
    nextPaymentDate: null,
    description: 'vieja',
    clientsInvoicedId: 'ca-1',
    deletedAt: null,
  };

  const FULL_UPDATE = {
    invoiceNumber: 'FB-0002',
    status: 'Pagado',
    montoPorPagar: 999.99,
    lastPaymentDate: '2026-07-01',
    nextPaymentDate: '2026-09-01',
    description: 'actualizada',
    importHash: 'bill-hash-2',
  };

  it('applies EVERY writable field onto the right row (id + tenantId in the where)', async () => {
    const db = buildDb({ billings: [{ ...EXISTING }] });
    await BillingRepository.update(
      'bl-1',
      { ...FULL_UPDATE, clientsInvoiced: 'ca-2' },
      repoOptions(db),
    );

    const firstFind = db.billing.calls.findOne[0];
    assert.strictEqual(firstFind.where.id, 'bl-1');
    assert.strictEqual(firstFind.where.tenantId, TENANT);

    const row = db.billing.rows[0];
    assert.ok(row.__updateCalls.length >= 1, 'row.update was never called');
    const patch = row.__updateCalls[0];
    for (const [k, v] of Object.entries(FULL_UPDATE)) {
      assert.deepStrictEqual(patch[k], v, `field "${k}" was dropped or altered on update`);
    }
    assert.strictEqual(patch.clientsInvoicedId, 'ca-2');
    assert.strictEqual(patch.updatedById, USER_ID);
    assert.strictEqual(row.status, 'Pagado');
    assert.strictEqual(row.montoPorPagar, 999.99);
  });

  // FIXED: BillingRepository.update now only sets clientsInvoicedId when the
  // `clientsInvoiced` key is present in the payload (hasOwnProperty guard) —
  // partial updates no longer unlink the invoiced client.
  it('a partial update must NOT clobber the client link that was not sent', async () => {
    const db = buildDb({ billings: [{ ...EXISTING }] });
    await BillingRepository.update('bl-1', { status: 'Pagado' }, repoOptions(db));
    assert.strictEqual(
      db.billing.rows[0].clientsInvoicedId,
      'ca-1',
      'clientsInvoicedId wiped by partial update',
    );
  });

  it('throws Error404 (and writes nothing) when the id belongs to another tenant', async () => {
    const db = buildDb({ billings: [{ ...EXISTING, tenantId: OTHER_TENANT }] });
    await assert.rejects(
      () => BillingRepository.update('bl-1', { ...FULL_UPDATE }, repoOptions(db)),
      (e: any) => e instanceof Error404,
    );
    assert.strictEqual(db.billing.rows[0].__updateCalls.length, 0);
  });

  it('a db failure on row.update PROPAGATES through the service (rollback, not swallowed)', async () => {
    const db = buildDb({ billings: [{ ...EXISTING }] });
    db.billing.rows[0].update = async () => {
      throw new Error('write failed');
    };
    await assert.rejects(
      () => new BillingService(repoOptions(db)).update('bl-1', { ...FULL_UPDATE }),
      /write failed/,
    );
    assert.strictEqual(db.__tx.rollbacks, 1);
  });

  it('destroy soft-deletes the tenant-scoped row only', async () => {
    const db = buildDb({ billings: [{ ...EXISTING }] });
    await BillingRepository.destroy('bl-1', repoOptions(db));
    assert.strictEqual(db.billing.rows[0].__destroyed, true);
    const firstFind = db.billing.calls.findOne[0];
    assert.strictEqual(firstFind.where.tenantId, TENANT);
  });
});

// ═══════════════════════════════ invoice ════════════════════════════════════
describe('crud-g11 · invoiceRepository.create', () => {
  // Every writable field the CRM invoice form can send (repository whitelist +
  // model definition in src/database/models/invoice.ts).
  const FULL_CREATE = {
    invoiceNumber: 'INV-100',
    status: 'Borrador',
    sentAt: null,
    poSoNumber: 'PO-77',
    title: 'Factura julio',
    summary: 'Guardianía + rondas',
    date: '2026-07-01',
    dueDate: '2026-07-31',
    items: [{ name: 'Guardia 24h', quantity: 2, rate: 500 }],
    payments: [],
    notes: 'Pagadero a 30 días',
    subtotal: 1000,
    total: 1150,
    importHash: 'inv-hash-1',
  };

  it('persists EVERY writable field the form sends (field fidelity)', async () => {
    const db = buildDb();
    await InvoiceRepository.create(
      { ...FULL_CREATE, clientId: 'ca-1', postSiteId: 'bi-1' },
      repoOptions(db),
    );

    assert.strictEqual(db.invoice.calls.create.length, 1);
    const written = db.invoice.calls.create[0];
    for (const [k, v] of Object.entries(FULL_CREATE)) {
      assert.deepStrictEqual(written[k], v, `field "${k}" was dropped or altered on create`);
    }
    assert.strictEqual(written.clientId, 'ca-1');
    assert.strictEqual(written.postSiteId, 'bi-1');
    assert.strictEqual(written.tenantId, TENANT);
    assert.strictEqual(written.createdById, USER_ID);
    assert.strictEqual(written.updatedById, USER_ID);
  });

  // FIXED: referenceEstimateId is now in InvoiceRepository.create's whitelist,
  // on the invoice model, and added by migration
  // z20260716b-invoice-reference-estimate.ts — the convert dedupe check works.
  it('persists referenceEstimateId so estimate→invoice conversion is idempotent', async () => {
    const db = buildDb();
    await InvoiceRepository.create(
      { ...FULL_CREATE, referenceEstimateId: 'es-1' },
      repoOptions(db),
    );
    assert.strictEqual(db.invoice.calls.create[0].referenceEstimateId, 'es-1');
  });
});

describe('crud-g11 · invoiceRepository.update / invoiceService', () => {
  const EXISTING = {
    id: 'inv-1',
    tenantId: TENANT,
    invoiceNumber: 'INV-100',
    status: 'Borrador',
    clientId: 'ca-1',
    postSiteId: 'bi-1',
    items: [{ name: 'Guardia', quantity: 1, rate: 100 }],
    payments: [],
    subtotal: 100,
    total: 100,
    deletedAt: null,
  };
  const seedClient = [{ id: 'ca-1', tenantId: TENANT, name: 'Andina', deletedAt: null }];
  const seedSite = [{ id: 'bi-1', tenantId: TENANT, companyName: 'Sitio Norte', deletedAt: null }];

  const FULL_UPDATE = {
    invoiceNumber: 'INV-101',
    status: 'Enviado',
    sentAt: '2026-07-10T12:00:00Z',
    poSoNumber: 'PO-88',
    title: 'Título nuevo',
    summary: 'Resumen nuevo',
    date: '2026-07-10',
    dueDate: '2026-08-10',
    items: [{ name: 'Supervisor', quantity: 1, rate: 800 }],
    payments: [{ id: 'p-1', amount: 50 }],
    notes: 'nota nueva',
    subtotal: 800,
    total: 920,
    importHash: 'inv-hash-2',
  };

  it('applies EVERY writable field onto the right row (id + tenantId in the where)', async () => {
    const db = buildDb({ invoices: [{ ...EXISTING }] });
    await InvoiceRepository.update('inv-1', { ...FULL_UPDATE }, repoOptions(db));

    const firstFind = db.invoice.calls.findOne[0];
    assert.strictEqual(firstFind.where.id, 'inv-1');
    assert.strictEqual(firstFind.where.tenantId, TENANT);

    const row = db.invoice.rows[0];
    const patch = row.__updateCalls[0];
    for (const [k, v] of Object.entries(FULL_UPDATE)) {
      assert.deepStrictEqual(patch[k], v, `field "${k}" was dropped or altered on update`);
    }
    assert.strictEqual(patch.updatedById, USER_ID);
    assert.strictEqual(row.status, 'Enviado');
    assert.deepStrictEqual(row.payments, FULL_UPDATE.payments);
  });

  it('repo-level partial update KEEPS clientId/postSiteId when the keys are absent (guard works)', async () => {
    const db = buildDb({ invoices: [{ ...EXISTING }] });
    await InvoiceRepository.update('inv-1', { status: 'Pagado' }, repoOptions(db));
    const row = db.invoice.rows[0];
    const patch = row.__updateCalls[0];
    assert.ok(!('clientId' in patch), 'clientId must not be in the patch when not sent');
    assert.ok(!('postSiteId' in patch), 'postSiteId must not be in the patch when not sent');
    assert.strictEqual(row.clientId, 'ca-1');
    assert.strictEqual(row.postSiteId, 'bi-1');
  });

  // FIXED: InvoiceService.update now runs filterIdInTenant on clientId/postSiteId
  // only when those keys are present in the payload, so the repository's
  // hasOwnProperty anti-clobber guard works for API callers too.
  it('a status-only update through the SERVICE must keep the client & site links', async () => {
    const db = buildDb({
      invoices: [{ ...EXISTING }],
      clientAccounts: seedClient,
      businessInfos: seedSite,
    });
    await new InvoiceService(repoOptions(db)).update('inv-1', { status: 'Pagado' });
    const row = db.invoice.rows[0];
    assert.strictEqual(row.clientId, 'ca-1', 'clientId wiped by service-level partial update');
    assert.strictEqual(row.postSiteId, 'bi-1', 'postSiteId wiped by service-level partial update');
  });

  it('throws Error404 (and writes nothing) when the id belongs to another tenant', async () => {
    const db = buildDb({ invoices: [{ ...EXISTING, tenantId: OTHER_TENANT }] });
    await assert.rejects(
      () => InvoiceRepository.update('inv-1', { ...FULL_UPDATE }, repoOptions(db)),
      (e: any) => e instanceof Error404,
    );
    assert.strictEqual(db.invoice.rows[0].__updateCalls.length, 0);
  });

  it('service auto-generates the invoiceNumber when missing (MAX+1) and commits', async () => {
    const db = buildDb({ clientAccounts: seedClient, businessInfos: seedSite });
    db.sequelize.__queryResults = [{ max: 41 }];
    await new InvoiceService(repoOptions(db)).create({
      title: 'Sin número',
      clientId: 'ca-1',
      postSiteId: 'bi-1',
      total: 10,
    });
    assert.strictEqual(db.invoice.calls.create[0].invoiceNumber, '42');
    assert.strictEqual(db.invoice.calls.create[0].clientId, 'ca-1');
    assert.strictEqual(db.__tx.commits, 1);
  });

  it('service keeps a caller-provided invoiceNumber untouched', async () => {
    const db = buildDb({ clientAccounts: seedClient, businessInfos: seedSite });
    await new InvoiceService(repoOptions(db)).create({
      invoiceNumber: 'CUSTOM-9',
      clientId: 'ca-1',
      postSiteId: 'bi-1',
      total: 10,
    });
    assert.strictEqual(db.invoice.calls.create[0].invoiceNumber, 'CUSTOM-9');
  });

  it('a db failure on update PROPAGATES through the service (rollback, no fake success)', async () => {
    const db = buildDb({
      invoices: [{ ...EXISTING }],
      clientAccounts: seedClient,
      businessInfos: seedSite,
    });
    db.invoice.rows[0].update = async () => {
      throw new Error('write exploded');
    };
    await assert.rejects(
      () => new InvoiceService(repoOptions(db)).update('inv-1', { ...FULL_UPDATE, clientId: 'ca-1', postSiteId: 'bi-1' }),
      /write exploded/,
    );
    assert.strictEqual(db.__tx.rollbacks, 1);
    assert.strictEqual(db.__tx.commits, 0);
  });
});

// ═══════════════════════════════ estimate ═══════════════════════════════════
describe('crud-g11 · estimateRepository create/update', () => {
  // Every writable field the CRM estimate form can send (repository whitelist +
  // model definition in src/database/models/estimate.ts).
  const FULL_CREATE = {
    estimateNumber: 'EST-10',
    poSoNumber: 'PO-55',
    title: 'Presupuesto evento',
    summary: 'Cobertura concierto',
    date: '2026-07-15',
    expiryDate: '2026-08-15',
    items: [{ name: 'Guardia evento', quantity: 4, rate: 120 }],
    notes: 'Válido 30 días',
    subtotal: 480,
    total: 552,
    importHash: 'est-hash-1',
  };

  const EXISTING = {
    id: 'es-1',
    tenantId: TENANT,
    estimateNumber: 'EST-10',
    title: 'Viejo',
    clientId: 'ca-1',
    postSiteId: 'bi-1',
    items: [],
    subtotal: 0,
    total: 0,
    deletedAt: null,
  };

  it('create persists EVERY writable field the form sends (field fidelity)', async () => {
    const db = buildDb();
    await EstimateRepository.create(
      { ...FULL_CREATE, clientId: 'ca-1', postSiteId: 'bi-1' },
      repoOptions(db),
    );
    assert.strictEqual(db.estimate.calls.create.length, 1);
    const written = db.estimate.calls.create[0];
    for (const [k, v] of Object.entries(FULL_CREATE)) {
      assert.deepStrictEqual(written[k], v, `field "${k}" was dropped or altered on create`);
    }
    assert.strictEqual(written.clientId, 'ca-1');
    assert.strictEqual(written.postSiteId, 'bi-1');
    assert.strictEqual(written.tenantId, TENANT);
    assert.strictEqual(written.createdById, USER_ID);
    assert.strictEqual(written.updatedById, USER_ID);
  });

  it('update applies EVERY writable field onto the right row (id + tenantId in the where)', async () => {
    const db = buildDb({ estimates: [{ ...EXISTING }] });
    const patch = {
      estimateNumber: 'EST-11',
      poSoNumber: 'PO-56',
      title: 'Nuevo título',
      summary: 'Nuevo resumen',
      date: '2026-07-20',
      expiryDate: '2026-08-20',
      items: [{ name: 'Supervisor', quantity: 1, rate: 300 }],
      notes: 'nota nueva',
      subtotal: 300,
      total: 345,
      importHash: 'est-hash-2',
    };
    await EstimateRepository.update(
      'es-1',
      { ...patch, clientId: 'ca-2', postSiteId: 'bi-2' },
      repoOptions(db),
    );

    const firstFind = db.estimate.calls.findOne[0];
    assert.strictEqual(firstFind.where.id, 'es-1');
    assert.strictEqual(firstFind.where.tenantId, TENANT);

    const row = db.estimate.rows[0];
    const written = row.__updateCalls[0];
    for (const [k, v] of Object.entries(patch)) {
      assert.deepStrictEqual(written[k], v, `field "${k}" was dropped or altered on update`);
    }
    assert.strictEqual(written.clientId, 'ca-2');
    assert.strictEqual(written.postSiteId, 'bi-2');
    assert.strictEqual(written.updatedById, USER_ID);
  });

  // FIXED: EstimateRepository.update now only sets clientId/postSiteId when the
  // keys are present in the payload (hasOwnProperty guard, same as
  // invoiceRepository) — send()'s { status, sentAt } patch no longer unlinks
  // the estimate's client and site.
  it('a partial update must NOT clobber clientId/postSiteId (send() wipes them today)', async () => {
    const db = buildDb({ estimates: [{ ...EXISTING }] });
    await EstimateRepository.update('es-1', { title: 'Solo título' }, repoOptions(db));
    const row = db.estimate.rows[0];
    assert.strictEqual(row.clientId, 'ca-1', 'clientId wiped by partial update');
    assert.strictEqual(row.postSiteId, 'bi-1', 'postSiteId wiped by partial update');
  });

  // FIXED: status/sentAt are now in the estimate repository's create/update
  // whitelists and on the estimate model (columns added by migration
  // z20260716a-estimate-status-sentat.ts) — the 'Enviado' mark persists.
  it("send()'s { status: 'Enviado', sentAt } patch must actually persist", async () => {
    const db = buildDb({ estimates: [{ ...EXISTING }] });
    await EstimateRepository.update(
      'es-1',
      { status: 'Enviado', sentAt: new Date('2026-07-10T12:00:00Z') },
      repoOptions(db),
    );
    const written = db.estimate.rows[0].__updateCalls[0];
    assert.strictEqual(written.status, 'Enviado', 'status was dropped by the update whitelist');
    assert.ok(written.sentAt, 'sentAt was dropped by the update whitelist');
  });

  it('update on a foreign-tenant estimate throws Error404 and writes nothing', async () => {
    const db = buildDb({ estimates: [{ ...EXISTING, tenantId: OTHER_TENANT }] });
    await assert.rejects(
      () => EstimateRepository.update('es-1', { title: 'X' }, repoOptions(db)),
      (e: any) => e instanceof Error404,
    );
    assert.strictEqual(db.estimate.rows[0].__updateCalls.length, 0);
  });
});

describe('crud-g11 · estimateService', () => {
  const seedClient = [{ id: 'ca-1', tenantId: TENANT, name: 'Andina', deletedAt: null }];
  const seedSite = [{ id: 'bi-1', tenantId: TENANT, companyName: 'Sitio Norte', deletedAt: null }];

  it('create auto-generates the estimateNumber (numeric max+1) when missing and commits', async () => {
    const db = buildDb({
      clientAccounts: seedClient,
      businessInfos: seedSite,
      estimates: [{ id: 'es-0', tenantId: TENANT, estimateNumber: 'EST-7', deletedAt: null }],
    });
    await new EstimateService(repoOptions(db)).create({
      title: 'Sin número',
      clientId: 'ca-1',
      postSiteId: 'bi-1',
      total: 10,
    });
    assert.strictEqual(db.estimate.calls.create[0].estimateNumber, '8');
    assert.strictEqual(db.estimate.calls.create[0].clientId, 'ca-1');
    assert.strictEqual(db.__tx.commits, 1);
  });

  it('a db failure on update PROPAGATES (rollback, no fake success)', async () => {
    const db = buildDb({
      clientAccounts: seedClient,
      businessInfos: seedSite,
      estimates: [{ id: 'es-1', tenantId: TENANT, estimateNumber: 'EST-1', clientId: 'ca-1', deletedAt: null }],
    });
    db.estimate.rows[0].update = async () => {
      throw new Error('estimate write failed');
    };
    await assert.rejects(
      () => new EstimateService(repoOptions(db)).update('es-1', { title: 'Y', clientId: 'ca-1', postSiteId: 'bi-1' }),
      /estimate write failed/,
    );
    assert.strictEqual(db.__tx.rollbacks, 1);
  });

  it('convert copies items/totals/title/client onto a NEW invoice and removes the estimate', async () => {
    const items = [{ name: 'Guardia evento', quantity: 4, rate: 120 }];
    const db = buildDb({
      clientAccounts: seedClient,
      businessInfos: seedSite,
      estimates: [{
        id: 'es-1',
        tenantId: TENANT,
        estimateNumber: 'EST-9',
        title: 'Presupuesto evento',
        clientId: 'ca-1',
        postSiteId: 'bi-1',
        items,
        notes: 'nota',
        subtotal: 480,
        total: 552,
        deletedAt: null,
      }],
    });
    const invoice = await new EstimateService(repoOptions(db)).convert('es-1');

    assert.strictEqual(db.invoice.calls.create.length, 1, 'exactly one invoice must be created');
    const written = db.invoice.calls.create[0];
    assert.deepStrictEqual(written.items, items, 'items not copied to the invoice');
    assert.strictEqual(written.subtotal, 480);
    assert.strictEqual(written.total, 552);
    assert.strictEqual(written.notes, 'nota');
    assert.strictEqual(written.title, 'Presupuesto evento');
    assert.strictEqual(written.clientId, 'ca-1');
    assert.strictEqual(written.postSiteId, 'bi-1');
    assert.strictEqual(written.tenantId, TENANT);
    assert.ok(invoice, 'convert must return the invoice');
    assert.strictEqual(db.estimate.rows[0].__destroyed, true, 'estimate must be removed after conversion');
  });
});

// ═════════════════════════════════ tax ══════════════════════════════════════
describe('crud-g11 · taxRepository / taxService', () => {
  // Every writable field the Settings › Impuestos form can send (repository
  // whitelist + model definition in src/database/models/tax.ts).
  const FULL_CREATE = {
    name: 'IVA 15%',
    rate: 15,
    description: 'Impuesto al valor agregado',
    active: true,
  };

  it('create persists EVERY writable field (field fidelity) and commits via the service', async () => {
    const db = buildDb();
    await new TaxService(repoOptions(db)).create({ ...FULL_CREATE });
    assert.strictEqual(db.tax.calls.create.length, 1);
    const written = db.tax.calls.create[0];
    for (const [k, v] of Object.entries(FULL_CREATE)) {
      assert.deepStrictEqual(written[k], v, `field "${k}" was dropped or altered on create`);
    }
    assert.strictEqual(written.tenantId, TENANT);
    assert.strictEqual(written.createdById, USER_ID);
    assert.strictEqual(written.updatedById, USER_ID);
    assert.strictEqual(db.__tx.commits, 1);
  });

  it('create rejects a duplicate name inside the tenant with Error400 (no silent create)', async () => {
    const db = buildDb({
      taxes: [{ id: 'tx-0', tenantId: TENANT, name: 'IVA 15%', rate: 15, deletedAt: null }],
    });
    await assert.rejects(
      () => TaxRepository.create({ ...FULL_CREATE }, repoOptions(db)),
      (e: any) => e instanceof Error400,
    );
    assert.strictEqual(db.tax.calls.create.length, 0);
  });

  it('create ALLOWS the same name in a different tenant (scoped uniqueness)', async () => {
    const db = buildDb({
      taxes: [{ id: 'tx-0', tenantId: OTHER_TENANT, name: 'IVA 15%', rate: 15, deletedAt: null }],
    });
    await TaxRepository.create({ ...FULL_CREATE }, repoOptions(db));
    assert.strictEqual(db.tax.calls.create.length, 1);
  });

  // FIXED: TaxRepository.create/update no longer wrap the duplicate-name check
  // in a swallow-everything-but-Error400 try/catch — infrastructure failures
  // propagate instead of silently skipping the uniqueness gate.
  it('an infra failure during the duplicate check must propagate, not be swallowed', async () => {
    const db = buildDb();
    db.tax.findOne = async () => {
      throw new Error('DB down');
    };
    await assert.rejects(
      () => TaxRepository.create({ ...FULL_CREATE }, repoOptions(db)),
      /DB down/,
    );
    assert.strictEqual(db.tax.calls.create.length, 0);
  });

  it('update targets {id, tenantId} and applies EVERY writable field', async () => {
    const db = buildDb({
      taxes: [{ id: 'tx-1', tenantId: TENANT, name: 'IVA 12%', rate: 12, description: 'vieja', active: true, deletedAt: null }],
    });
    const patch = { name: 'IVA 15%', rate: 15, description: 'nueva', active: false };
    await TaxRepository.update('tx-1', { ...patch }, repoOptions(db));

    const firstFind = db.tax.calls.findOne[0];
    assert.strictEqual(firstFind.where.id, 'tx-1');
    assert.strictEqual(firstFind.where.tenantId, TENANT);

    const row = db.tax.rows[0];
    const written = row.__updateCalls[0];
    for (const [k, v] of Object.entries(patch)) {
      assert.deepStrictEqual(written[k], v, `field "${k}" was dropped or altered on update`);
    }
    assert.strictEqual(written.updatedById, USER_ID);
    assert.strictEqual(row.active, false);
  });

  it("update rejects renaming onto ANOTHER tax's name in the tenant (Error400, no write)", async () => {
    const db = buildDb({
      taxes: [
        { id: 'tx-1', tenantId: TENANT, name: 'IVA 12%', rate: 12, deletedAt: null },
        { id: 'tx-2', tenantId: TENANT, name: 'IVA 15%', rate: 15, deletedAt: null },
      ],
    });
    await assert.rejects(
      () => TaxRepository.update('tx-1', { name: 'IVA 15%' }, repoOptions(db)),
      (e: any) => e instanceof Error400,
    );
    assert.strictEqual(db.tax.rows[0].__updateCalls.length, 0);
  });

  it('update on a foreign-tenant tax throws Error404 and writes nothing', async () => {
    const db = buildDb({
      taxes: [{ id: 'tx-1', tenantId: OTHER_TENANT, name: 'IVA', rate: 12, deletedAt: null }],
    });
    await assert.rejects(
      () => TaxRepository.update('tx-1', { rate: 15 }, repoOptions(db)),
      (e: any) => e instanceof Error404,
    );
    assert.strictEqual(db.tax.rows[0].__updateCalls.length, 0);
  });

  it('a db failure on update PROPAGATES through the service (rollback, no fake success)', async () => {
    const db = buildDb({
      taxes: [{ id: 'tx-1', tenantId: TENANT, name: 'IVA', rate: 12, deletedAt: null }],
    });
    db.tax.rows[0].update = async () => {
      throw new Error('tax write failed');
    };
    await assert.rejects(
      () => new TaxService(repoOptions(db)).update('tx-1', { rate: 15 }),
      /tax write failed/,
    );
    assert.strictEqual(db.__tx.rollbacks, 1);
  });

  it('destroy soft-deletes the tenant-scoped row', async () => {
    const db = buildDb({
      taxes: [{ id: 'tx-1', tenantId: TENANT, name: 'IVA', rate: 12, deletedAt: null }],
    });
    await TaxRepository.destroy('tx-1', repoOptions(db));
    assert.strictEqual(db.tax.rows[0].__destroyed, true);
  });
});

// ═══════════════════════════════ payment ════════════════════════════════════
describe('crud-g11 · paymentService.create (append to invoice.payments)', () => {
  // clientId/postSiteId left null so findById's relation back-fill branch stays off.
  const INVOICE = {
    id: 'inv-1',
    tenantId: TENANT,
    invoiceNumber: 'INV-100',
    status: 'Enviado',
    clientId: null,
    postSiteId: null,
    items: [],
    payments: [] as any[],
    subtotal: 100,
    total: 100,
    deletedAt: null,
  };

  it('persists EVERY payment field the form sends, prepended to the payments array', async () => {
    const db = buildDb({ invoices: [{ ...INVOICE, payments: [{ id: 'p-0', amount: 10 }] }] });
    const payment = await new PaymentService(repoOptions(db)).create({
      invoiceId: 'inv-1',
      amount: '25.50',
      date: '2026-07-12T10:00:00Z',
      method: 'transferencia',
      note: 'abono parcial',
    });

    assert.strictEqual(payment.amount, 25.5, 'amount not numeric-coerced');
    assert.strictEqual(payment.date, '2026-07-12T10:00:00Z');
    assert.strictEqual(payment.method, 'transferencia');
    assert.strictEqual(payment.note, 'abono parcial');
    assert.strictEqual(payment.createdById, USER_ID);
    assert.ok(payment.id, 'payment must get an id');

    const row = db.invoice.rows[0];
    const patch = row.__updateCalls.find((c: any) => 'payments' in c);
    assert.ok(patch, 'invoice.payments was never written');
    assert.strictEqual(patch.payments.length, 2, 'existing payment lost on append');
    assert.strictEqual(patch.payments[0].id, payment.id, 'new payment must be prepended');
    assert.strictEqual(patch.payments[1].id, 'p-0');
    // Guard fix: a payments-only update must NOT null the client/site links.
    assert.ok(!('clientId' in patch), 'payment append must not touch clientId');
    assert.strictEqual(db.__tx.commits, 1);
  });

  it('falls back note → reference when note is absent', async () => {
    const db = buildDb({ invoices: [{ ...INVOICE }] });
    const payment = await new PaymentService(repoOptions(db)).create({
      invoiceId: 'inv-1',
      amount: 10,
      reference: 'REF-77',
    });
    assert.strictEqual(payment.note, 'REF-77');
  });

  it('rejects a payment that would exceed the invoice total (400, NOTHING written, rollback)', async () => {
    const db = buildDb({
      invoices: [{ ...INVOICE, total: 100, payments: [{ id: 'p-0', amount: 80 }] }],
    });
    await assert.rejects(
      () => new PaymentService(repoOptions(db)).create({ invoiceId: 'inv-1', amount: 30 }),
      (e: any) => e.code === 400,
    );
    assert.strictEqual(db.invoice.rows[0].__updateCalls.length, 0, 'must not write on over-total');
    assert.strictEqual(db.__tx.rollbacks, 1);
    assert.strictEqual(db.__tx.commits, 0);
  });

  it('rejects a missing invoiceId with a 400 before touching the db', async () => {
    const db = buildDb({ invoices: [{ ...INVOICE }] });
    await assert.rejects(
      () => new PaymentService(repoOptions(db)).create({ amount: 10 }),
      (e: any) => e.code === 400,
    );
    assert.strictEqual(db.invoice.rows[0].__updateCalls.length, 0);
  });

  it("refuses to pay another tenant's invoice (404 propagates, rollback, nothing written)", async () => {
    const db = buildDb({ invoices: [{ ...INVOICE, tenantId: OTHER_TENANT }] });
    await assert.rejects(
      () => new PaymentService(repoOptions(db)).create({ invoiceId: 'inv-1', amount: 10 }),
      (e: any) => e instanceof Error404,
    );
    assert.strictEqual(db.invoice.rows[0].__updateCalls.length, 0);
    assert.strictEqual(db.__tx.rollbacks, 1);
  });

  it('a db failure on the payments write PROPAGATES (rollback, not swallowed into success)', async () => {
    const db = buildDb({ invoices: [{ ...INVOICE }] });
    db.invoice.rows[0].update = async () => {
      throw new Error('payments write failed');
    };
    await assert.rejects(
      () => new PaymentService(repoOptions(db)).create({ invoiceId: 'inv-1', amount: 10 }),
      /payments write failed/,
    );
    assert.strictEqual(db.__tx.rollbacks, 1);
    assert.strictEqual(db.__tx.commits, 0);
  });
});
