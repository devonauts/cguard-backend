/**
 * Unit tests — CRUD persistence fidelity for the g10-inventory group.
 *
 * Context: tenants report "things are not being saved". The classic causes are
 * (1) a handler accepts a field but the repository DROPS it before the write,
 * (2) update paths whose where-clause / whitelist silently ignores changes,
 * (3) swallowed errors (try/catch returning success anyway).
 *
 * Covered (REAL repository/service/handler code against a Sequelize-shaped
 * fake db — no MySQL, no network):
 *   - inventoryRepository create/update            (field fidelity, where target,
 *                                                   cross-tenant 404, handler-level
 *                                                   error propagation via service)
 *   - inventoryItemRepository create/update        (+ photos file relation,
 *                                                   service error propagation)
 *   - inventoryAssignmentRepository create/update/destroy (+ item status sync)
 *   - inventoryAssignmentService                   (BUG: broken transaction arg)
 *   - inventoryHistoryRepository create/update     (BUG: patrol fields dropped on update)
 *   - vehicleRepository create/update              (+ imageUrl file relation)
 *   - radioDevice create/update handlers           (full express handlers,
 *                                                   password encryption, 500 on db error)
 *
 * Run:
 *   cross-env NODE_ENV=test TS_NODE_PROJECT=tsconfig.test.json \
 *     npx mocha -r ts-node/register \
 *     'tests/unit/crud-g10-inventory/**\/*.test.ts' --exit --timeout 20000
 */

import assert from 'assert';
import sinon from 'sinon';
import Sequelize from 'sequelize';

import InventoryRepository from '../../../src/database/repositories/inventoryRepository';
import InventoryItemRepository from '../../../src/database/repositories/inventoryItemRepository';
import InventoryAssignmentRepository from '../../../src/database/repositories/inventoryAssignmentRepository';
import InventoryHistoryRepository from '../../../src/database/repositories/inventoryHistoryRepository';
import VehicleRepository from '../../../src/database/repositories/vehicleRepository';
import AuditLogRepository from '../../../src/database/repositories/auditLogRepository';
import FileRepository from '../../../src/database/repositories/fileRepository';
import Error404 from '../../../src/errors/Error404';

import InventoryItemService from '../../../src/services/inventoryItemService';
import InventoryAssignmentService from '../../../src/services/inventoryAssignmentService';

import inventoryCreateHandler from '../../../src/api/inventory/inventoryCreate';
import radioDeviceCreateHandler from '../../../src/api/radioDevice/create';
import radioDeviceUpdateHandler from '../../../src/api/radioDevice/update';
import { isEncrypted, decrypt } from '../../../src/lib/secretBox';

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
    async getImageUrl() {
      return [];
    },
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
      count: [] as any[],
    },
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

function buildDb(seed: {
  inventories?: any[];
  inventoryItems?: any[];
  inventoryAssignments?: any[];
  inventoryHistories?: any[];
  vehicles?: any[];
  radioDevices?: any[];
  stations?: any[];
  businessInfos?: any[];
} = {}) {
  const db: any = {
    inventory: makeModel('inventory', seed.inventories || []),
    inventoryItem: makeModel('inventoryItem', seed.inventoryItems || []),
    inventoryAssignment: makeModel('inventoryAssignment', seed.inventoryAssignments || []),
    inventoryHistory: makeModel('inventoryHistory', seed.inventoryHistories || []),
    vehicle: makeModel('vehicle', seed.vehicles || []),
    radioDevice: makeModel('radioDevice', seed.radioDevices || []),
    station: makeModel('station', seed.stations || []),
    businessInfo: makeModel('businessInfo', seed.businessInfos || []),
    clientAccount: makeModel('clientAccount', []),
    tenantUser: makeModel('tenantUser', []),
    user: makeModel('user', []),
    file: makeModel('file', []),
    guardShift: makeModel('guardShift', []),
    patrol: makeModel('patrol', []),
    patrolCheckpoint: makeModel('patrolCheckpoint', []),
    // Fake transaction factory for service-level tests (records commit/rollback).
    sequelize: {
      __commits: 0,
      __rollbacks: 0,
      async transaction() {
        const s = db.sequelize;
        return {
          async commit() { s.__commits += 1; },
          async rollback() { s.__rollbacks += 1; },
        };
      },
    },
  };
  return db;
}

// Admin-shaped current user: makes inventoryRepository._resolveAllowedStationIds
// return null (unrestricted) and passes PermissionChecker in handler tests.
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

// ═══════════════════════════ inventory ══════════════════════════════════════
// Every writable field the CRM "Inventario por puesto" form can send (per the
// repository whitelist + model definition).
const INVENTORY_FULL = {
  name: 'Dotación Puesto Norte',
  belongsToStation: 'st-1',
  radio: true,
  radioType: 'Motorola EP450',
  radioSerialNumber: 'RAD-001',
  gun: true,
  gunType: 'revolver',
  gunSerialNumber: 'GUN-001',
  armor: true,
  armorType: 'Nivel IIIA',
  armorSerialNumber: 'ARM-001',
  armorExpirationDate: '2027-05-01',
  tolete: true,
  pito: true,
  linterna: true,
  vitacora: true,
  cintoCompleto: true,
  ponchoDeAguas: true,
  detectorDeMetales: true,
  caseta: true,
  observations: 'Todo el equipo en buen estado',
  transportation: 'Moto',
  importHash: 'hash-inv-1',
};

describe('crud-g10 · inventoryRepository.create', () => {
  it('persists EVERY writable field the form sends (field fidelity)', async () => {
    const db = buildDb();
    await InventoryRepository.create(
      { ...INVENTORY_FULL, belongsTo: 'st-1' },
      repoOptions(db),
    );

    assert.strictEqual(db.inventory.calls.create.length, 1);
    const written = db.inventory.calls.create[0];
    for (const [k, v] of Object.entries(INVENTORY_FULL)) {
      assert.deepStrictEqual(written[k], v, `field "${k}" was dropped or altered on create`);
    }
    assert.strictEqual(written.belongsToId, 'st-1', 'belongsTo → belongsToId mapping lost');
    assert.strictEqual(written.tenantId, TENANT);
    assert.strictEqual(written.createdById, USER_ID);
    assert.strictEqual(written.updatedById, USER_ID);
  });

  it('a db failure on create REJECTS (no swallowed error)', async () => {
    const db = buildDb();
    db.inventory.create = async () => {
      throw new Error('DB down');
    };
    await assert.rejects(
      () => InventoryRepository.create({ ...INVENTORY_FULL, belongsTo: 'st-1' }, repoOptions(db)),
      /DB down/,
    );
  });
});

describe('crud-g10 · inventoryRepository.update', () => {
  const seedRow = () => ({
    id: 'inv-1',
    tenantId: TENANT,
    ...INVENTORY_FULL,
    observations: 'estado inicial',
    belongsToId: 'st-1',
  });

  it('targets the right row (id + tenantId) and applies EVERY changed field', async () => {
    const db = buildDb({ inventories: [seedRow()] });
    const patch = {
      ...INVENTORY_FULL,
      name: 'Dotación renombrada',
      radio: false,
      radioType: 'Kenwood TK-3402',
      radioSerialNumber: 'RAD-999',
      gunType: 'pistola de fuego',
      observations: 'radio dañada, enviada a mantenimiento',
      transportation: 'Bicicleta',
      armorExpirationDate: '2028-01-15',
      belongsTo: 'st-2',
    };
    await InventoryRepository.update('inv-1', patch, repoOptions(db));

    // where-clause targets id + tenant
    const q = db.inventory.calls.findOne[0];
    assert.strictEqual(q.where.id, 'inv-1');
    assert.strictEqual(q.where.tenantId, TENANT);

    const row = db.inventory.rows[0];
    assert.strictEqual(row.__updateCalls.length, 1);
    const applied = row.__updateCalls[0];
    const { belongsTo, ...expectFields } = patch;
    for (const [k, v] of Object.entries(expectFields)) {
      assert.deepStrictEqual(applied[k], v, `field "${k}" silently ignored on update`);
    }
    assert.strictEqual(applied.belongsToId, 'st-2', 'belongsTo → belongsToId mapping lost on update');
    assert.strictEqual(applied.updatedById, USER_ID);
    assert.strictEqual(row.observations, 'radio dañada, enviada a mantenimiento');
  });

  it('throws Error404 for a row in ANOTHER tenant (no silent cross-tenant write)', async () => {
    const db = buildDb({ inventories: [{ ...seedRow(), tenantId: OTHER_TENANT }] });
    await assert.rejects(
      () => InventoryRepository.update('inv-1', { observations: 'x' }, repoOptions(db)),
      Error404,
    );
    assert.strictEqual(db.inventory.rows[0].__updateCalls.length, 0);
  });
});

describe('crud-g10 · inventory create through the REAL handler + service', () => {
  it('handler responds 200 and the created row keeps every field (incl. validated belongsTo)', async () => {
    const db = buildDb({ stations: [{ id: 'st-1', tenantId: TENANT }] });
    const req = fakeReq(db, { body: { data: { ...INVENTORY_FULL, belongsTo: 'st-1' } } });
    const res = fakeRes();
    await inventoryCreateHandler(req, res, () => {});

    assert.strictEqual(res.statusCode, 200, `expected 200, got ${res.statusCode}: ${JSON.stringify(res.body)}`);
    const written = db.inventory.calls.create[0];
    assert.strictEqual(written.belongsToId, 'st-1');
    assert.strictEqual(written.belongsToStation, 'st-1');
    assert.strictEqual(written.observations, INVENTORY_FULL.observations);
    assert.strictEqual(db.sequelize.__commits, 1, 'transaction was not committed');
  });

  it('a db failure surfaces as an error response (5xx), NEVER a fake success', async () => {
    const db = buildDb({ stations: [{ id: 'st-1', tenantId: TENANT }] });
    db.inventory.create = async () => {
      throw new Error('insert failed');
    };
    const req = fakeReq(db, { body: { data: { ...INVENTORY_FULL, belongsTo: 'st-1' } } });
    const res = fakeRes();
    await inventoryCreateHandler(req, res, () => {});

    assert.ok(res.statusCode >= 500, `db failure must not produce a success (got ${res.statusCode})`);
    assert.strictEqual(db.sequelize.__rollbacks, 1, 'transaction was not rolled back');
  });
});

// ═══════════════════════════ inventoryItem ══════════════════════════════════
const ITEM_FULL = {
  name: 'Radio Motorola EP450',
  type: 'radio',
  brand: 'Motorola',
  modelName: 'EP450',
  serialNumber: 'SN-12345',
  condition: 'bueno',
  status: 'disponible',
  notes: 'Batería nueva 2026',
  expirationDate: '2027-12-31',
  importHash: 'hash-item-1',
};

describe('crud-g10 · inventoryItemRepository.create', () => {
  it('persists EVERY writable field (field fidelity) + tenant/user stamps', async () => {
    const db = buildDb();
    await InventoryItemRepository.create({ ...ITEM_FULL }, repoOptions(db));

    const written = db.inventoryItem.calls.create[0];
    for (const [k, v] of Object.entries(ITEM_FULL)) {
      assert.deepStrictEqual(written[k], v, `field "${k}" was dropped or altered on create`);
    }
    assert.strictEqual(written.tenantId, TENANT);
    assert.strictEqual(written.createdById, USER_ID);
    assert.strictEqual(written.updatedById, USER_ID);
  });

  it('wires the photos file relation when photos are sent', async () => {
    const db = buildDb();
    const photos = [{ id: 'f-1', name: 'radio.jpg' }];
    await InventoryItemRepository.create({ ...ITEM_FULL, photos }, repoOptions(db));

    const stub = FileRepository.replaceRelationFiles as sinon.SinonStub;
    assert.strictEqual(stub.callCount, 1, 'photos relation not written');
    assert.strictEqual(stub.firstCall.args[0].belongsToColumn, 'photos');
    assert.deepStrictEqual(stub.firstCall.args[1], photos);
  });

  it('does NOT touch the photos relation when photos are omitted', async () => {
    const db = buildDb();
    await InventoryItemRepository.create({ ...ITEM_FULL }, repoOptions(db));
    const stub = FileRepository.replaceRelationFiles as sinon.SinonStub;
    assert.strictEqual(stub.callCount, 0);
  });
});

describe('crud-g10 · inventoryItemRepository.update', () => {
  it('targets id + tenantId and applies EVERY changed field', async () => {
    const db = buildDb({ inventoryItems: [{ id: 'item-1', tenantId: TENANT, ...ITEM_FULL }] });
    const patch = {
      name: 'Radio Kenwood',
      type: 'radio',
      brand: 'Kenwood',
      modelName: 'TK-3402',
      serialNumber: 'SN-99999',
      condition: 'regular',
      status: 'en_mantenimiento',
      notes: 'antena rota',
      expirationDate: '2028-06-30',
      importHash: 'hash-item-2',
    };
    await InventoryItemRepository.update('item-1', patch, repoOptions(db));

    const q = db.inventoryItem.calls.findOne[0];
    assert.strictEqual(q.where.id, 'item-1');
    assert.strictEqual(q.where.tenantId, TENANT);

    const applied = db.inventoryItem.rows[0].__updateCalls[0];
    for (const [k, v] of Object.entries(patch)) {
      assert.deepStrictEqual(applied[k], v, `field "${k}" silently ignored on update`);
    }
    assert.strictEqual(applied.updatedById, USER_ID);
  });

  it('throws Error404 for a row in ANOTHER tenant', async () => {
    const db = buildDb({ inventoryItems: [{ id: 'item-1', tenantId: OTHER_TENANT, ...ITEM_FULL }] });
    await assert.rejects(
      () => InventoryItemRepository.update('item-1', { notes: 'x' }, repoOptions(db)),
      Error404,
    );
  });
});

describe('crud-g10 · inventoryItemService error propagation', () => {
  it('service.create REJECTS and rolls back when the db write fails (no swallowed error)', async () => {
    const db = buildDb();
    db.inventoryItem.create = async () => {
      throw new Error('insert failed');
    };
    const svc = new InventoryItemService(repoOptions(db));
    await assert.rejects(() => svc.create({ ...ITEM_FULL }), /insert failed/);
    assert.strictEqual(db.sequelize.__rollbacks, 1);
    assert.strictEqual(db.sequelize.__commits, 0);
  });
});

// ═══════════════════════════ inventoryAssignment ════════════════════════════
const ASSIGNMENT_FULL = {
  inventoryItemId: 'item-1',
  stationId: 'st-1',
  postSiteId: 'ps-1',
  assignedToUserId: 'guard-7',
  assignedAt: '2026-07-14T08:00:00.000Z',
  returnedAt: null as any,
  conditionAtCheckout: 'bueno',
  conditionAtReturn: null as any,
  notes: 'Entregado al inicio del turno',
  returnNotes: null as any,
  importHash: 'hash-asg-1',
};

describe('crud-g10 · inventoryAssignmentRepository.create', () => {
  it('persists EVERY writable field and flips the item to "asignado"', async () => {
    const db = buildDb({
      inventoryItems: [{ id: 'item-1', tenantId: TENANT, ...ITEM_FULL, status: 'disponible' }],
    });
    await InventoryAssignmentRepository.create({ ...ASSIGNMENT_FULL }, repoOptions(db));

    const written = db.inventoryAssignment.calls.create[0];
    for (const [k, v] of Object.entries(ASSIGNMENT_FULL)) {
      assert.deepStrictEqual(written[k], v, `field "${k}" was dropped or altered on create`);
    }
    assert.strictEqual(written.tenantId, TENANT);
    assert.strictEqual(written.createdById, USER_ID);

    // The item status side-write must have happened (checkout with no return).
    assert.strictEqual(db.inventoryItem.calls.update.length, 1);
    assert.strictEqual(db.inventoryItem.calls.update[0].values.status, 'asignado');
    assert.strictEqual(db.inventoryItem.rows[0].status, 'asignado');
  });

  it('a historical (already-returned) assignment does NOT flip the item status', async () => {
    const db = buildDb({
      inventoryItems: [{ id: 'item-1', tenantId: TENANT, ...ITEM_FULL, status: 'disponible' }],
    });
    await InventoryAssignmentRepository.create(
      { ...ASSIGNMENT_FULL, returnedAt: '2026-07-14T16:00:00.000Z', conditionAtReturn: 'bueno' },
      repoOptions(db),
    );
    assert.strictEqual(db.inventoryItem.calls.update.length, 0);
    assert.strictEqual(db.inventoryItem.rows[0].status, 'disponible');
  });

  // FIXED: inventoryAssignmentRepository.create now tenant-validates
  // data.inventoryItemId (404 on foreign items) and the item-status
  // side-writes are tenant-scoped.
  it('rejects (or ignores) an inventoryItemId belonging to ANOTHER tenant', async () => {
    const db = buildDb({
      inventoryItems: [{ id: 'item-x', tenantId: OTHER_TENANT, ...ITEM_FULL, status: 'disponible' }],
    });
    await InventoryAssignmentRepository.create(
      { ...ASSIGNMENT_FULL, inventoryItemId: 'item-x' },
      repoOptions(db),
    ).catch(() => null);
    assert.strictEqual(
      db.inventoryItem.rows[0].status,
      'disponible',
      'cross-tenant item status was mutated',
    );
  });
});

describe('crud-g10 · inventoryAssignmentRepository.update', () => {
  const seedAssignment = (over: any = {}) => ({
    id: 'asg-1',
    tenantId: TENANT,
    ...ASSIGNMENT_FULL,
    ...over,
  });

  it('targets id + tenantId, applies the return fields, and frees the item', async () => {
    const db = buildDb({
      inventoryAssignments: [seedAssignment()],
      inventoryItems: [{ id: 'item-1', tenantId: TENANT, ...ITEM_FULL, status: 'asignado' }],
    });
    const patch = {
      stationId: 'st-2',
      postSiteId: 'ps-2',
      assignedToUserId: 'guard-9',
      assignedAt: '2026-07-14T08:30:00.000Z',
      returnedAt: '2026-07-14T20:00:00.000Z',
      conditionAtCheckout: 'bueno',
      conditionAtReturn: 'regular',
      notes: 'nota editada',
      returnNotes: 'devuelto con rayones',
      importHash: 'hash-asg-2',
    };
    await InventoryAssignmentRepository.update('asg-1', patch, repoOptions(db));

    const q = db.inventoryAssignment.calls.findOne[0];
    assert.strictEqual(q.where.id, 'asg-1');
    assert.strictEqual(q.where.tenantId, TENANT);

    const applied = db.inventoryAssignment.rows[0].__updateCalls[0];
    for (const [k, v] of Object.entries(patch)) {
      assert.deepStrictEqual(applied[k], v, `field "${k}" silently ignored on update`);
    }
    assert.strictEqual(applied.updatedById, USER_ID);

    // Returning the item frees it.
    assert.strictEqual(db.inventoryItem.rows[0].status, 'disponible');
  });

  it('throws Error404 for an assignment in ANOTHER tenant', async () => {
    const db = buildDb({ inventoryAssignments: [seedAssignment({ tenantId: OTHER_TENANT })] });
    await assert.rejects(
      () => InventoryAssignmentRepository.update('asg-1', { notes: 'x' }, repoOptions(db)),
      Error404,
    );
  });

  // FIXED: update() now derives the item status from the record's PERSISTED
  // returnedAt (post-update), not the raw incoming patch.
  it('a notes-only edit of a RETURNED assignment keeps the item "disponible"', async () => {
    const db = buildDb({
      inventoryAssignments: [
        seedAssignment({ returnedAt: '2026-07-10T18:00:00.000Z', conditionAtReturn: 'bueno' }),
      ],
      inventoryItems: [{ id: 'item-1', tenantId: TENANT, ...ITEM_FULL, status: 'disponible' }],
    });
    await InventoryAssignmentRepository.update('asg-1', { notes: 'solo edito la nota' }, repoOptions(db));
    assert.strictEqual(
      db.inventoryItem.rows[0].status,
      'disponible',
      'item was wrongly re-marked asignado by a notes-only edit',
    );
  });
});

describe('crud-g10 · inventoryAssignmentRepository.destroy', () => {
  it('frees the item when its last active assignment is deleted', async () => {
    const db = buildDb({
      inventoryAssignments: [{ id: 'asg-1', tenantId: TENANT, ...ASSIGNMENT_FULL }],
      inventoryItems: [{ id: 'item-1', tenantId: TENANT, ...ITEM_FULL, status: 'asignado' }],
    });
    await InventoryAssignmentRepository.destroy('asg-1', repoOptions(db));
    assert.strictEqual(db.inventoryAssignment.rows[0].__destroyed, true);
    assert.strictEqual(db.inventoryItem.rows[0].status, 'disponible');
  });
});

describe('crud-g10 · inventoryAssignmentService (transaction plumbing)', () => {
  // FIXED: the service now passes this.options.database (not the express req)
  // to SequelizeRepository.createTransaction, like inventoryItemService does.
  it('service.create persists an assignment', async () => {
    const db = buildDb({
      inventoryItems: [{ id: 'item-1', tenantId: TENANT, ...ITEM_FULL, status: 'disponible' }],
    });
    const req = fakeReq(db); // real handler shape: options === req (has .database, no .sequelize)
    const svc = new InventoryAssignmentService(req);
    const created = await svc.create({ ...ASSIGNMENT_FULL });
    assert.ok(created, 'assignment should be created');
    assert.strictEqual(db.inventoryAssignment.calls.create.length, 1);
  });

  it('service.create commits the transaction; a repo failure rolls it back and rejects', async () => {
    const db = buildDb({
      inventoryItems: [{ id: 'item-1', tenantId: TENANT, ...ITEM_FULL, status: 'disponible' }],
    });
    const req = fakeReq(db);
    const svc = new InventoryAssignmentService(req);
    await svc.create({ ...ASSIGNMENT_FULL });
    assert.strictEqual(db.sequelize.__commits, 1, 'transaction was not committed');
    assert.strictEqual(db.sequelize.__rollbacks, 0);

    // Failure path: the write throws → rollback + rejection (no swallowed error).
    db.inventoryAssignment.create = async () => {
      throw new Error('insert failed');
    };
    await assert.rejects(() => svc.create({ ...ASSIGNMENT_FULL }), /insert failed/);
    assert.strictEqual(db.sequelize.__rollbacks, 1, 'transaction was not rolled back');
  });
});

// ═══════════════════════════ inventoryHistory ═══════════════════════════════
const HISTORY_FULL = {
  inventoryCheckedDate: '2026-07-14',
  isComplete: true,
  observation: 'Inventario completo, sin novedad',
  importHash: 'hash-hist-1',
  // relation fields as the service passes them (already tenant-validated ids)
  shiftOrigin: 'gs-1',
  patrol: 'pat-1',
  patrolCheckpoint: 'pc-1',
  inventoryOrigin: 'inv-1',
};

describe('crud-g10 · inventoryHistoryRepository.create', () => {
  it('persists every field + maps shiftOrigin/patrol/patrolCheckpoint/inventoryOrigin to *Id columns', async () => {
    const db = buildDb();
    await InventoryHistoryRepository.create({ ...HISTORY_FULL }, repoOptions(db));

    const written = db.inventoryHistory.calls.create[0];
    assert.strictEqual(written.inventoryCheckedDate, HISTORY_FULL.inventoryCheckedDate);
    assert.strictEqual(written.isComplete, true);
    assert.strictEqual(written.observation, HISTORY_FULL.observation);
    assert.strictEqual(written.importHash, HISTORY_FULL.importHash);
    assert.strictEqual(written.shiftOriginId, 'gs-1');
    assert.strictEqual(written.patrolId, 'pat-1');
    assert.strictEqual(written.patrolCheckpointId, 'pc-1');
    assert.strictEqual(written.inventoryOriginId, 'inv-1');
    assert.strictEqual(written.tenantId, TENANT);
    assert.strictEqual(written.createdById, USER_ID);
  });
});

describe('crud-g10 · inventoryHistoryRepository.update', () => {
  const seedHistory = () => ({
    id: 'hist-1',
    tenantId: TENANT,
    inventoryCheckedDate: '2026-07-10',
    isComplete: false,
    observation: 'faltó la linterna',
    importHash: 'hash-hist-1',
    shiftOriginId: 'gs-1',
    patrolId: 'pat-1',
    patrolCheckpointId: 'pc-1',
    inventoryOriginId: 'inv-1',
  });

  it('targets id + tenantId and applies the whitelisted fields + relation ids', async () => {
    const db = buildDb({ inventoryHistories: [seedHistory()] });
    await InventoryHistoryRepository.update(
      'hist-1',
      {
        inventoryCheckedDate: '2026-07-14',
        isComplete: true,
        observation: 'corregido: completo',
        importHash: 'hash-hist-2',
        shiftOrigin: 'gs-2',
        inventoryOrigin: 'inv-2',
      },
      repoOptions(db),
    );

    const q = db.inventoryHistory.calls.findOne[0];
    assert.strictEqual(q.where.id, 'hist-1');
    assert.strictEqual(q.where.tenantId, TENANT);

    const applied = db.inventoryHistory.rows[0].__updateCalls[0];
    assert.strictEqual(applied.inventoryCheckedDate, '2026-07-14');
    assert.strictEqual(applied.isComplete, true);
    assert.strictEqual(applied.observation, 'corregido: completo');
    assert.strictEqual(applied.importHash, 'hash-hist-2');
    assert.strictEqual(applied.shiftOriginId, 'gs-2');
    assert.strictEqual(applied.inventoryOriginId, 'inv-2');
    assert.strictEqual(applied.updatedById, USER_ID);
  });

  it('throws Error404 for a row in ANOTHER tenant', async () => {
    const db = buildDb({ inventoryHistories: [{ ...seedHistory(), tenantId: OTHER_TENANT }] });
    await assert.rejects(
      () => InventoryHistoryRepository.update('hist-1', { observation: 'x' }, repoOptions(db)),
      Error404,
    );
  });

  // FIXED: update() now maps data.patrol/data.patrolCheckpoint to
  // patrolId/patrolCheckpointId (presence-guarded: omitted keys are untouched).
  it('applies patrol / patrolCheckpoint changes on update', async () => {
    const db = buildDb({ inventoryHistories: [seedHistory()] });
    await InventoryHistoryRepository.update(
      'hist-1',
      { ...HISTORY_FULL, patrol: 'pat-2', patrolCheckpoint: 'pc-2' },
      repoOptions(db),
    );
    const row = db.inventoryHistory.rows[0];
    assert.strictEqual(row.patrolId, 'pat-2', 'patrol change silently dropped on update');
    assert.strictEqual(row.patrolCheckpointId, 'pc-2', 'patrolCheckpoint change silently dropped on update');
  });
});

// ═══════════════════════════ vehicle ════════════════════════════════════════
const VEHICLE_FULL = {
  name: 'Camioneta Patrulla 1',
  licensePlate: 'PBX-1234',
  active: true,
  importHash: 'hash-veh-1',
  year: 2023,
  make: 'Chevrolet',
  model: 'D-Max',
  color: 'Blanco',
  vin: '8LDETF3D0P0123456',
  initialMileage: 45210,
  ownership: 'propio',
  description: 'Unidad asignada a patrullaje nocturno',
};

describe('crud-g10 · vehicleRepository.create', () => {
  it('persists EVERY writable field (field fidelity) + tenant/user stamps', async () => {
    const db = buildDb();
    await VehicleRepository.create({ ...VEHICLE_FULL }, repoOptions(db));

    const written = db.vehicle.calls.create[0];
    for (const [k, v] of Object.entries(VEHICLE_FULL)) {
      assert.deepStrictEqual(written[k], v, `field "${k}" was dropped or altered on create`);
    }
    assert.strictEqual(written.tenantId, TENANT);
    assert.strictEqual(written.createdById, USER_ID);
    assert.strictEqual(written.updatedById, USER_ID);
  });

  it('wires the imageUrl file relation with the sent files', async () => {
    const db = buildDb();
    const image = [{ id: 'f-9', name: 'truck.jpg' }];
    await VehicleRepository.create({ ...VEHICLE_FULL, imageUrl: image }, repoOptions(db));
    const stub = FileRepository.replaceRelationFiles as sinon.SinonStub;
    assert.ok(stub.callCount >= 1, 'imageUrl relation not written');
    assert.strictEqual(stub.firstCall.args[0].belongsToColumn, 'imageUrl');
    assert.deepStrictEqual(stub.firstCall.args[1], image);
  });
});

describe('crud-g10 · vehicleRepository.update', () => {
  it('targets id + tenantId and applies EVERY changed field', async () => {
    const db = buildDb({ vehicles: [{ id: 'veh-1', tenantId: TENANT, ...VEHICLE_FULL }] });
    const patch = {
      name: 'Camioneta Patrulla 2',
      licensePlate: 'PCA-5678',
      active: false,
      year: 2024,
      make: 'Toyota',
      model: 'Hilux',
      color: 'Gris',
      vin: 'MR0EX8CD3P0654321',
      initialMileage: 120,
      ownership: 'alquilado',
      description: 'reasignada a supervisión',
    };
    await VehicleRepository.update('veh-1', patch, repoOptions(db));

    const q = db.vehicle.calls.findOne[0];
    assert.strictEqual(q.where.id, 'veh-1');
    assert.strictEqual(q.where.tenantId, TENANT);

    const applied = db.vehicle.rows[0].__updateCalls[0];
    for (const [k, v] of Object.entries(patch)) {
      assert.deepStrictEqual(applied[k], v, `field "${k}" silently ignored on update`);
    }
    assert.strictEqual(applied.updatedById, USER_ID);
  });

  it('throws Error404 for a vehicle in ANOTHER tenant', async () => {
    const db = buildDb({ vehicles: [{ id: 'veh-1', tenantId: OTHER_TENANT, ...VEHICLE_FULL }] });
    await assert.rejects(
      () => VehicleRepository.update('veh-1', { name: 'x' }, repoOptions(db)),
      Error404,
    );
  });
});

// ═══════════════════════════ radioDevice (handlers) ═════════════════════════
const RADIO_FULL = {
  name: 'Gateway RoIP Bodega',
  host: '10.0.0.50',
  sipPort: 5070,
  transport: 'tcp',
  sipUsername: 'roip-user',
  sipPassword: 'super-secret-pass',
  sipDomain: 'sip.cguard.local',
  registerRequired: false,
  extension: '7001',
  codec: 'pcma',
  rtpPortStart: 17000,
  rtpPortEnd: 17100,
  postSiteId: 'ps-1',
  stationId: 'st-1',
  notes: 'canal principal de bodega',
  active: true,
};

describe('crud-g10 · radioDevice create handler', () => {
  it('persists EVERY writable field, encrypts the SIP password, never returns it', async () => {
    const db = buildDb();
    const req = fakeReq(db, { body: { data: { ...RADIO_FULL } } });
    const res = fakeRes();
    await radioDeviceCreateHandler(req, res);

    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    const written = db.radioDevice.calls.create[0];
    const { sipPassword, ...plainFields } = RADIO_FULL;
    for (const [k, v] of Object.entries(plainFields)) {
      assert.deepStrictEqual(written[k], v, `field "${k}" was dropped or altered on create`);
    }
    assert.strictEqual(written.tenantId, TENANT);
    assert.strictEqual(written.createdById, USER_ID);
    assert.strictEqual(written.status, 'unknown');
    // Password stored encrypted (round-trips), never in clear, never echoed.
    assert.ok(isEncrypted(written.sipPassword), 'sipPassword not encrypted at rest');
    assert.strictEqual(decrypt(written.sipPassword), 'super-secret-pass');
    assert.strictEqual(res.body.sipPassword, undefined, 'sipPassword leaked in the response');
    assert.strictEqual(res.body.sipPasswordConfigured, true);
    assert.strictEqual(res.body.sipPasswordLast4, 'pass');
  });

  it('a db failure returns an error status (500), NEVER a fake success', async () => {
    const db = buildDb();
    db.radioDevice.create = async () => {
      throw new Error('insert failed');
    };
    const req = fakeReq(db, { body: { data: { ...RADIO_FULL } } });
    const res = fakeRes();
    await radioDeviceCreateHandler(req, res);
    assert.ok(res.statusCode >= 500, `db failure must not produce a success (got ${res.statusCode})`);
  });
});

describe('crud-g10 · radioDevice update handler', () => {
  const seedDevice = (over: any = {}) => ({
    id: 'rd-1',
    tenantId: TENANT,
    ...RADIO_FULL,
    sipPassword: 'enc-old-password-envelope',
    status: 'registered',
    ...over,
  });

  it('targets id + tenantId and applies EVERY sent field (partial-update whitelist)', async () => {
    const db = buildDb({ radioDevices: [seedDevice()] });
    const patch = {
      name: 'Gateway renombrado',
      host: '10.0.0.99',
      sipPort: 5080,
      transport: 'tls',
      sipUsername: 'nuevo-user',
      sipDomain: 'sip2.cguard.local',
      registerRequired: true,
      extension: '7002',
      codec: 'pcmu',
      rtpPortStart: 18000,
      rtpPortEnd: 18100,
      postSiteId: 'ps-2',
      stationId: 'st-2',
      notes: 'movido a garita norte',
      active: false,
    };
    const req = fakeReq(db, { params: { id: 'rd-1' }, body: { data: { ...patch } } });
    const res = fakeRes();
    await radioDeviceUpdateHandler(req, res);

    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    const q = db.radioDevice.calls.findOne[0];
    assert.strictEqual(q.where.id, 'rd-1');
    assert.strictEqual(q.where.tenantId, TENANT);

    const applied = db.radioDevice.rows[0].__updateCalls[0];
    for (const [k, v] of Object.entries(patch)) {
      assert.deepStrictEqual(applied[k], v, `field "${k}" silently ignored on update`);
    }
    assert.strictEqual(applied.updatedById, USER_ID);
    // No password sent → stored password untouched.
    assert.strictEqual(applied.sipPassword, undefined);
    assert.strictEqual(db.radioDevice.rows[0].sipPassword, 'enc-old-password-envelope');
  });

  it('an EMPTY sipPassword does not wipe the stored one; a new one is re-encrypted', async () => {
    const db = buildDb({ radioDevices: [seedDevice()] });
    // empty string → keep
    let req = fakeReq(db, { params: { id: 'rd-1' }, body: { data: { sipPassword: '' } } });
    await radioDeviceUpdateHandler(req, fakeRes());
    assert.strictEqual(db.radioDevice.rows[0].sipPassword, 'enc-old-password-envelope');
    // real value → re-encrypted
    req = fakeReq(db, { params: { id: 'rd-1' }, body: { data: { sipPassword: 'new-pass' } } });
    await radioDeviceUpdateHandler(req, fakeRes());
    assert.ok(isEncrypted(db.radioDevice.rows[0].sipPassword));
    assert.strictEqual(decrypt(db.radioDevice.rows[0].sipPassword), 'new-pass');
  });

  it('updating a device of ANOTHER tenant returns 404 and writes nothing', async () => {
    const db = buildDb({ radioDevices: [seedDevice({ tenantId: OTHER_TENANT })] });
    const req = fakeReq(db, { params: { id: 'rd-1' }, body: { data: { name: 'hijack' } } });
    const res = fakeRes();
    await radioDeviceUpdateHandler(req, res);
    assert.strictEqual(res.statusCode, 404);
    assert.strictEqual(db.radioDevice.rows[0].__updateCalls.length, 0);
  });
});
