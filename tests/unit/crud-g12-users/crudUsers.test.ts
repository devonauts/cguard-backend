/**
 * Unit tests — CRUD persistence fidelity for the g12-users group.
 *
 * Context: tenants report "things are not being saved". The classic causes are
 * (1) a handler accepts a field but the repository DROPS it before the write,
 * (2) update paths whose where-clause / whitelist silently ignores changes,
 * (3) swallowed errors (try/catch returning success anyway).
 *
 * Covered (REAL repository/service/handler code against a Sequelize-shaped
 * fake db — no MySQL, no network):
 *   - userRepository create/createFromAuth/update/patchUpdate/updatePassword/
 *     changeEmail                            (field fidelity, row targeting,
 *                                             identity-cache propagation,
 *                                             db-error propagation)
 *   - auth: sign-up write path (createFromAuth) + update-profile
 *     (AuthProfileEditor → updateProfile)     (commit/rollback, rethrow)
 *   - tenantRepository create/update          (full pick-list fidelity, url
 *                                             uniqueness, membership 404)
 *   - roleRepository create/update/resetToDefault/destroy
 *   - department handlers create/update/assignMember
 *   - settingsRepository.save via SettingsService (JSON blobs fidelity,
 *                                             logo/background no-clobber)
 *
 * Run:
 *   cross-env NODE_ENV=test TS_NODE_PROJECT=tsconfig.test.json \
 *     npx mocha -r ts-node/register \
 *     'tests/unit/crud-g12-users/**\/*.test.ts' --exit --timeout 20000
 */

import assert from 'assert';
import sinon from 'sinon';
import Sequelize from 'sequelize';

import UserRepository from '../../../src/database/repositories/userRepository';
import TenantRepository from '../../../src/database/repositories/tenantRepository';
import RoleRepository from '../../../src/database/repositories/roleRepository';
import AuditLogRepository from '../../../src/database/repositories/auditLogRepository';
import FileRepository from '../../../src/database/repositories/fileRepository';
import SettingsService from '../../../src/services/settingsService';
import AuthProfileEditor from '../../../src/services/auth/authProfileEditor';
import Error400 from '../../../src/errors/Error400';
import Error404 from '../../../src/errors/Error404';
import {
  ADMIN_FLOOR_PERMISSIONS,
  getStaticDefaultsForRole,
} from '../../../src/security/staticRolePermissions';

import departmentCreate from '../../../src/api/department/departmentCreate';
import departmentUpdate from '../../../src/api/department/departmentUpdate';
import departmentAssignMember from '../../../src/api/department/departmentAssignMember';

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
    async save() {
      return row;
    },
    async reload() {
      return row;
    },
    async destroy() {
      row.__destroyed = true;
      return row;
    },
    // Relation getters used by userRepository/settingsRepository fill steps.
    async getAvatars() {
      return [];
    },
    async getTenants() {
      return row.__tenants || [];
    },
    async getLogos() {
      return [];
    },
    async getBackgroundImages() {
      return [];
    },
    async getLegalDocuments() {
      return [];
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
    calls: {
      create: [] as any[],
      findOne: [] as any[],
      findAll: [] as any[],
      destroy: [] as any[],
      update: [] as any[],
      findOrCreate: [] as any[],
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
      return model.rows.find((r: any) => r.id === id && !r.__destroyed) || null;
    },
    async findOrCreate(q: any = {}) {
      model.calls.findOrCreate.push(q);
      const existing = model.rows.find((r: any) => !r.__destroyed && matchWhere(r, q.where));
      if (existing) return [existing, false];
      const row = await model.create({ ...(q.defaults || {}) });
      return [row, true];
    },
    async count(q: any = {}) {
      return model.rows.filter((r: any) => !r.__destroyed && matchWhere(r, q.where)).length;
    },
    // Model-level (static) update — records the call, applies to matching rows.
    async update(values: any, q: any = {}) {
      model.calls.update.push({ values: { ...values }, where: q.where });
      const victims = model.rows.filter((r: any) => !r.__destroyed && matchWhere(r, q.where));
      victims.forEach((r: any) => Object.assign(r, values));
      return [victims.length];
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

/** Fake transaction tracker so services' commit/rollback can be asserted. */
function makeTx() {
  const tx: any = { commits: 0, rollbacks: 0 };
  tx.commit = async () => {
    tx.commits += 1;
  };
  tx.rollback = async () => {
    tx.rollbacks += 1;
  };
  return tx;
}

function buildDb(seed: {
  users?: any[];
  tenants?: any[];
  roles?: any[];
  departments?: any[];
  tenantUsers?: any[];
  settings?: any[];
  securityGuards?: any[];
  clientAccounts?: any[];
} = {}) {
  const tx = makeTx();
  const db: any = {
    __tx: tx,
    Sequelize,
    sequelize: { transaction: async () => tx },
    user: makeModel('user', seed.users || []),
    tenant: makeModel('tenant', seed.tenants || []),
    role: makeModel('role', seed.roles || []),
    department: makeModel('department', seed.departments || []),
    tenantUser: makeModel('tenantUser', seed.tenantUsers || []),
    settings: makeModel('setting', seed.settings || []),
    securityGuard: makeModel('securityGuard', seed.securityGuards || []),
    clientAccount: makeModel('clientAccount', seed.clientAccounts || []),
    businessInfo: makeModel('businessInfo', []),
    file: makeModel('file', []),
  };
  return db;
}

function repoOptions(db: any, tenantId = TENANT, currentUser: any = { id: USER_ID }) {
  return {
    currentUser,
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
    email: 'admin@x.ec',
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

// A user row with the membership relation the findById fill step consumes.
function seedUser(over: any = {}) {
  return {
    id: 'u-1',
    email: 'juan@x.ec',
    firstName: 'Juan',
    lastName: 'Pérez',
    fullName: 'Juan Pérez',
    phoneNumber: '0999111222',
    deletedAt: null,
    __tenants: [{ tenant: { id: TENANT }, status: 'active', roles: ['admin'] }],
    ...over,
  };
}

// ═══════════════════════════ userRepository ═════════════════════════════════
describe('crud-g12 · userRepository.create', () => {
  const FULL_CREATE = {
    email: 'nuevo@x.ec',
    fullName: 'Ana María Salazar',
    firstName: 'Ana María',
    lastName: 'Salazar',
    phoneNumber: '0988777666',
    importHash: 'h-user-1',
  };

  it('persists EVERY writable field the form sends (field fidelity)', async () => {
    const db = buildDb();
    await UserRepository.create({ ...FULL_CREATE }, repoOptions(db));

    assert.strictEqual(db.user.calls.create.length, 1);
    const written = db.user.calls.create[0];
    for (const [k, v] of Object.entries(FULL_CREATE)) {
      assert.deepStrictEqual(written[k], v, `field "${k}" was dropped or altered on create`);
    }
    assert.strictEqual(written.createdById, USER_ID);
    assert.strictEqual(written.updatedById, USER_ID);
  });

  it('derives firstName/lastName when only fullName is provided', async () => {
    const db = buildDb();
    await UserRepository.create(
      { email: 'solo@x.ec', fullName: 'Carlos Alberto Mena' },
      repoOptions(db),
    );
    const written = db.user.calls.create[0];
    assert.strictEqual(written.firstName, 'Carlos');
    assert.strictEqual(written.lastName, 'Alberto Mena');
    assert.strictEqual(written.fullName, 'Carlos Alberto Mena');
  });

  it('wires the avatars through the file relation', async () => {
    const db = buildDb();
    const avatars = [{ id: 'f-1', name: 'foto.png' }];
    await UserRepository.create({ ...FULL_CREATE, avatars }, repoOptions(db));
    const stub = FileRepository.replaceRelationFiles as sinon.SinonStub;
    const call = stub.getCalls().find((c) => c.args[0].belongsToColumn === 'avatars');
    assert.ok(call, 'avatars relation not written');
    assert.deepStrictEqual(call!.args[1], avatars);
  });

  it('a db failure on create PROPAGATES (not swallowed into a success)', async () => {
    const db = buildDb();
    db.user.create = async () => {
      throw new Error('DB down');
    };
    await assert.rejects(
      () => UserRepository.create({ ...FULL_CREATE }, repoOptions(db)),
      /DB down/,
    );
  });
});

describe('crud-g12 · userRepository.createFromAuth (the sign-up write path)', () => {
  const FULL_SIGNUP = {
    email: 'signup@x.ec',
    password: '$2b$10$hashedvalue',
    fullName: 'Nueva Cuenta',
    firstName: 'Nueva',
    lastName: 'Cuenta',
    phoneNumber: '0977666555',
    importHash: 'h-signup',
    emailVerified: true,
    emailVerificationToken: 'evt-123',
    emailVerificationTokenExpiresAt: new Date('2026-08-01T00:00:00Z'),
    provider: 'local',
    providerId: 'prov-9',
    passwordResetToken: 'prt-1',
    passwordResetTokenExpiresAt: new Date('2026-08-02T00:00:00Z'),
    jwtTokenInvalidBefore: new Date('2026-07-01T00:00:00Z'),
  };

  it('persists EVERY sign-up field (password, tokens, provider, verification state)', async () => {
    const db = buildDb();
    await UserRepository.createFromAuth({ ...FULL_SIGNUP }, repoOptions(db));

    assert.strictEqual(db.user.calls.create.length, 1);
    const written = db.user.calls.create[0];
    for (const [k, v] of Object.entries(FULL_SIGNUP)) {
      assert.deepStrictEqual(written[k], v, `field "${k}" was dropped or altered on sign-up`);
    }
  });

  it('defaults emailVerified to false when the caller omits it', async () => {
    const db = buildDb();
    await UserRepository.createFromAuth(
      { email: 'plain@x.ec', password: 'hash', fullName: 'Plain User' },
      repoOptions(db),
    );
    assert.strictEqual(db.user.calls.create[0].emailVerified, false);
  });
});

describe('crud-g12 · userRepository.update', () => {
  it('applies firstName/lastName/phoneNumber + updatedById to the right row and syncs identity caches', async () => {
    // fullName: null — the real model hook rebuilds fullName from first/last on
    // update; the fake row has no hooks, so let identitySync derive it instead.
    const db = buildDb({
      users: [seedUser({ fullName: null })],
      securityGuards: [{ id: 'sg-1', guardId: 'u-1', tenantId: TENANT, fullName: 'Juan Pérez' }],
      clientAccounts: [{ id: 'ca-1', userId: 'u-1', name: 'Juan', deletedAt: null }],
    });
    await UserRepository.update(
      'u-1',
      { firstName: 'Carlos', lastName: 'Mena', phoneNumber: '0911222333' },
      repoOptions(db),
    );

    const row = db.user.rows[0];
    assert.ok(row.__updateCalls.length >= 1, 'row.update was never called');
    const patch = row.__updateCalls[0];
    assert.strictEqual(patch.firstName, 'Carlos');
    assert.strictEqual(patch.lastName, 'Mena');
    assert.strictEqual(patch.phoneNumber, '0911222333');
    assert.strictEqual(patch.updatedById, USER_ID);

    // Identity propagation: the denormalized caches follow the user row.
    const sgUpdate = db.securityGuard.calls.update[0];
    assert.ok(sgUpdate, 'securityGuard.fullName cache not synced');
    assert.strictEqual(sgUpdate.values.fullName, 'Carlos Mena');
    assert.strictEqual(sgUpdate.where.guardId, 'u-1');
    assert.strictEqual(sgUpdate.where.tenantId, TENANT);
    const caUpdate = db.clientAccount.calls.update[0];
    assert.ok(caUpdate, 'clientAccount identity cache not synced');
    assert.strictEqual(caUpdate.values.name, 'Carlos');
    assert.strictEqual(caUpdate.where.userId, 'u-1');
  });

  // FIXED: UserRepository.update is now presence-guarded — only the keys the
  // caller sent are written (Sequelize ignores undefined), so the
  // phone-verification flow's { phoneNumber, phoneNumberVerified } payload no
  // longer wipes firstName/lastName (nor the denormalized identity caches).
  it('a partial update (phoneNumber only) must NOT wipe firstName/lastName', async () => {
    const db = buildDb({ users: [seedUser()] });
    await UserRepository.update('u-1', { phoneNumber: '0900000001' }, repoOptions(db));
    const row = db.user.rows[0];
    assert.strictEqual(row.firstName, 'Juan', 'firstName wiped by partial update');
    assert.strictEqual(row.lastName, 'Pérez', 'lastName wiped by partial update');
  });

  // FIXED: UserRepository.update now maps phoneNumberVerified (presence-guarded)
  // and the user model gained the column (migration
  // z20260716-user-phone-number-verified) — the verification result persists.
  it('persists the phoneNumberVerified flag the verification flow sends', async () => {
    const db = buildDb({ users: [seedUser()] });
    await UserRepository.update(
      'u-1',
      { phoneNumber: '0900000001', phoneNumberVerified: true },
      repoOptions(db),
    );
    const patch = db.user.rows[0].__updateCalls[0];
    assert.strictEqual(patch.phoneNumberVerified, true, 'phoneNumberVerified dropped');
  });

  it('a db failure on row.update PROPAGATES (not swallowed)', async () => {
    const db = buildDb({ users: [seedUser()] });
    db.user.rows[0].update = async () => {
      throw new Error('write failed');
    };
    await assert.rejects(
      () => UserRepository.update('u-1', { firstName: 'X', lastName: 'Y', phoneNumber: '1' }, repoOptions(db)),
      /write failed/,
    );
  });
});

describe('crud-g12 · userRepository.patchUpdate (the partial-update path done right)', () => {
  const OFFICE_FIELDS = {
    firstName: 'Lucía',
    lastName: 'Andrade',
    phoneNumber: '0966555444',
    officeLatitude: '-0.180653',
    officeLongitude: '-78.467838',
    officeGeofenceRadiusM: '150',
    officeAddress: 'Av. República E5-32',
  };

  it('persists every provided field, coercing office coordinates to numbers', async () => {
    const db = buildDb({ users: [seedUser()] });
    await UserRepository.patchUpdate('u-1', { ...OFFICE_FIELDS }, repoOptions(db));

    const patch = db.user.rows[0].__updateCalls[0];
    assert.strictEqual(patch.firstName, 'Lucía');
    assert.strictEqual(patch.lastName, 'Andrade');
    assert.strictEqual(patch.phoneNumber, '0966555444');
    assert.strictEqual(patch.officeLatitude, -0.180653);
    assert.strictEqual(patch.officeLongitude, -78.467838);
    assert.strictEqual(patch.officeGeofenceRadiusM, 150);
    assert.strictEqual(patch.officeAddress, 'Av. República E5-32');
    assert.strictEqual(patch.updatedById, USER_ID);
  });

  it('a partial patch only touches the sent keys (no clobber)', async () => {
    const db = buildDb({ users: [seedUser()] });
    await UserRepository.patchUpdate('u-1', { phoneNumber: '0900000009' }, repoOptions(db));
    const patch = db.user.rows[0].__updateCalls[0];
    assert.deepStrictEqual(Object.keys(patch).sort(), ['phoneNumber', 'updatedById']);
    const row = db.user.rows[0];
    assert.strictEqual(row.firstName, 'Juan', 'firstName clobbered');
    assert.strictEqual(row.lastName, 'Pérez', 'lastName clobbered');
  });

  it('empty-string office coordinates are stored as null (cleared), not NaN', async () => {
    const db = buildDb({ users: [seedUser({ officeLatitude: -0.1, officeLongitude: -78.4 })] });
    await UserRepository.patchUpdate(
      'u-1',
      { officeLatitude: '', officeLongitude: '', officeGeofenceRadiusM: '' },
      repoOptions(db),
    );
    const patch = db.user.rows[0].__updateCalls[0];
    assert.strictEqual(patch.officeLatitude, null);
    assert.strictEqual(patch.officeLongitude, null);
    assert.strictEqual(patch.officeGeofenceRadiusM, null);
  });

  it('throws Error404 (writes nothing) when the user does not exist', async () => {
    const db = buildDb();
    await assert.rejects(
      () => UserRepository.patchUpdate('nope', { firstName: 'X' }, repoOptions(db)),
      (e: any) => e instanceof Error404,
    );
  });
});

describe('crud-g12 · userRepository.updatePassword / changeEmail', () => {
  it('updatePassword persists the hash; jwtTokenInvalidBefore only when invalidating', async () => {
    const db = buildDb({ users: [seedUser()] });
    await UserRepository.updatePassword('u-1', 'new-hash', false, repoOptions(db));
    let patch = db.user.rows[0].__updateCalls[0];
    assert.strictEqual(patch.password, 'new-hash');
    assert.strictEqual(patch.updatedById, USER_ID);
    assert.ok(!('jwtTokenInvalidBefore' in patch), 'must not invalidate tokens unless asked');

    await UserRepository.updatePassword('u-1', 'newer-hash', true, repoOptions(db));
    patch = db.user.rows[0].__updateCalls[1];
    assert.strictEqual(patch.password, 'newer-hash');
    assert.ok(patch.jwtTokenInvalidBefore instanceof Date, 'old tokens not invalidated');
  });

  it('changeEmail persists the new email and resets emailVerified', async () => {
    const db = buildDb({ users: [seedUser({ emailVerified: true })] });
    await UserRepository.changeEmail('u-1', 'correo.nuevo@x.ec', repoOptions(db));
    const patch = db.user.rows[0].__updateCalls[0];
    assert.strictEqual(patch.email, 'correo.nuevo@x.ec');
    assert.strictEqual(patch.emailVerified, false);
    assert.strictEqual(patch.updatedById, USER_ID);
  });

  it('changeEmail throws Error404 on a missing user (no silent success)', async () => {
    const db = buildDb();
    await assert.rejects(
      () => UserRepository.changeEmail('nope', 'x@x.ec', repoOptions(db)),
      (e: any) => e instanceof Error404,
    );
  });
});

// ═══════════════ auth · update-profile (AuthProfileEditor) ══════════════════
describe('crud-g12 · auth update-profile (AuthProfileEditor → updateProfile)', () => {
  function editorOptions(db: any) {
    return {
      currentUser: { id: 'u-1', email: 'juan@x.ec' },
      currentTenant: { id: TENANT },
      language: 'es',
      database: db,
    } as any;
  }

  it('persists the profile fields the form sends and commits', async () => {
    const db = buildDb({ users: [seedUser()] });
    const editor = new AuthProfileEditor(editorOptions(db));
    await editor.execute({ firstName: 'Juanito', lastName: 'Pérez B.', phoneNumber: '0955444333' });

    const patch = db.user.rows[0].__updateCalls[0];
    assert.strictEqual(patch.firstName, 'Juanito');
    assert.strictEqual(patch.lastName, 'Pérez B.');
    assert.strictEqual(patch.phoneNumber, '0955444333');
    assert.strictEqual(patch.updatedById, 'u-1');
    assert.strictEqual(db.__tx.commits, 1, 'transaction not committed');
  });

  it('a db failure is NOT swallowed: rolls back and rethrows', async () => {
    const db = buildDb({ users: [seedUser()] });
    db.user.rows[0].update = async () => {
      throw new Error('profile write failed');
    };
    const editor = new AuthProfileEditor(editorOptions(db));
    await assert.rejects(() => editor.execute({ firstName: 'X' }), /profile write failed/);
    assert.strictEqual(db.__tx.rollbacks, 1, 'transaction not rolled back');
  });

  // FIXED: UserRepository.updateProfile is now presence-guarded — a partial
  // profile PUT (avatar-only, phoneNumber-only) no longer nulls the unsent fields.
  it('update-profile with only phoneNumber must NOT wipe first/last name', async () => {
    const db = buildDb({ users: [seedUser()] });
    const editor = new AuthProfileEditor(editorOptions(db));
    await editor.execute({ phoneNumber: '0900000002' });
    const row = db.user.rows[0];
    assert.strictEqual(row.firstName, 'Juan', 'firstName wiped by partial profile update');
    assert.strictEqual(row.lastName, 'Pérez', 'lastName wiped by partial profile update');
  });
});

// ═══════════════════════════ tenantRepository ═══════════════════════════════
describe('crud-g12 · tenantRepository.create', () => {
  // Every writable field the company form / onboarding wizard can send
  // (per the repository pick-list + model definition).
  const FULL_TENANT = {
    name: 'Ecuaseguridad Total',
    url: 'ecuaseguridad',
    plan: 'free',
    importHash: 'h-tenant',
    address: 'Av. de los Shyris N40-120',
    addressLine2: 'Edificio Torre Azul, piso 4',
    postalCode: '170135',
    city: 'Quito',
    country: 'Ecuador',
    latitude: -0.180653,
    longitude: -78.467838,
    phone: '0999888777',
    email: 'contacto@ecuaseguridad.ec',
    logoId: 'file-logo-1',
    taxNumber: '1790012345001',
    businessTitle: 'Ecuaseguridad Total Cía. Ltda.',
    extraLines: 'RUC obligatorio en guías',
    website: 'https://ecuaseguridad.ec',
    licenseNumber: 'MDI-2026-001',
    timezone: 'America/Guayaquil',
  };

  function creatorOptions(db: any) {
    // Tenant create/update validate membership via currentUser.tenants.
    return repoOptions(db, TENANT, {
      id: USER_ID,
      tenants: [{ tenant: { id: 't-1' } }],
    });
  }

  it('persists EVERY writable field the company form sends (field fidelity)', async () => {
    const db = buildDb();
    await TenantRepository.create({ ...FULL_TENANT }, creatorOptions(db));

    assert.strictEqual(db.tenant.calls.create.length, 1);
    const written = db.tenant.calls.create[0];
    for (const [k, v] of Object.entries(FULL_TENANT)) {
      assert.deepStrictEqual(written[k], v, `field "${k}" was dropped or altered on create`);
    }
    assert.strictEqual(written.createdById, USER_ID);
    assert.strictEqual(written.updatedById, USER_ID);
  });

  // FIXED: `landline` added to the lodash.pick whitelists in
  // TenantRepository.create and .update — the company fixed line persists.
  it('persists the landline (model column added by migration 20260317)', async () => {
    const db = buildDb();
    await TenantRepository.create(
      { ...FULL_TENANT, landline: '023456789' },
      creatorOptions(db),
    );
    assert.strictEqual(db.tenant.calls.create[0].landline, '023456789');
  });

  it('rejects a duplicate url with Error400 (no silent create)', async () => {
    const db = buildDb({
      tenants: [{ id: 't-0', url: 'ecuaseguridad', name: 'Otro', deletedAt: null }],
    });
    await assert.rejects(
      () => TenantRepository.create({ ...FULL_TENANT }, creatorOptions(db)),
      (e: any) => e instanceof Error400,
    );
    assert.strictEqual(db.tenant.calls.create.length, 0, 'must not create on duplicate url');
  });

  it('normalizes an empty url to null (avoids unique-index collisions)', async () => {
    const db = buildDb();
    await TenantRepository.create({ ...FULL_TENANT, url: '   ' }, creatorOptions(db));
    assert.strictEqual(db.tenant.calls.create[0].url, null);
  });
});

describe('crud-g12 · tenantRepository.update', () => {
  const EXISTING = {
    id: 't-1',
    name: 'Vieja Razón Social',
    url: 'vieja-url',
    email: 'old@x.ec',
    businessTitle: 'Vieja Cía.',
    extraLines: '',
    website: '',
    licenseNumber: '',
    timezone: 'America/Guayaquil',
    deletedAt: null,
  };

  const FULL_UPDATE = {
    name: 'Nueva Razón Social',
    url: 'nueva-url',
    importHash: 'h-upd',
    address: 'Calle Nueva 123',
    addressLine2: 'Oficina 2B',
    postalCode: '170150',
    city: 'Guayaquil',
    country: 'Ecuador',
    latitude: -2.170998,
    longitude: -79.922359,
    phone: '0977666555',
    email: 'nuevo@x.ec',
    logoId: 'file-logo-2',
    taxNumber: '0990011223001',
    businessTitle: 'Nueva Cía. Ltda.',
    extraLines: 'Línea extra factura',
    website: 'https://nueva.ec',
    licenseNumber: 'MDI-2026-777',
    timezone: 'America/Bogota',
  };

  function memberOptions(db: any) {
    return repoOptions(db, TENANT, {
      id: USER_ID,
      tenants: [{ tenant: { id: 't-1' } }],
    });
  }

  it('applies EVERY writable field onto the row + updatedById', async () => {
    const db = buildDb({ tenants: [{ ...EXISTING }] });
    await TenantRepository.update('t-1', { ...FULL_UPDATE }, memberOptions(db));

    const row = db.tenant.rows[0];
    assert.ok(row.__updateCalls.length >= 1, 'row.update was never called');
    const patch = row.__updateCalls[0];
    for (const [k, v] of Object.entries(FULL_UPDATE)) {
      assert.deepStrictEqual(patch[k], v, `field "${k}" was dropped or altered on update`);
    }
    assert.strictEqual(patch.updatedById, USER_ID);
  });

  // FIXED: landline is in the update pick-list too.
  it('persists a landline change', async () => {
    const db = buildDb({ tenants: [{ ...EXISTING }] });
    await TenantRepository.update(
      't-1',
      { ...FULL_UPDATE, landline: '042222333' },
      memberOptions(db),
    );
    assert.strictEqual(db.tenant.rows[0].landline, '042222333');
  });

  it('keeps the existing url when the form sends url undefined', async () => {
    const db = buildDb({ tenants: [{ ...EXISTING }] });
    await TenantRepository.update(
      't-1',
      { ...FULL_UPDATE, url: undefined },
      memberOptions(db),
    );
    assert.strictEqual(db.tenant.rows[0].url, 'vieja-url');
  });

  it('a non-member of the tenant gets Error404 and nothing is written', async () => {
    const db = buildDb({ tenants: [{ ...EXISTING }] });
    const outsider = repoOptions(db, TENANT, {
      id: 'intruso',
      tenants: [{ tenant: { id: 'otro-tenant' } }],
    });
    await assert.rejects(
      () => TenantRepository.update('t-1', { ...FULL_UPDATE }, outsider),
      (e: any) => e instanceof Error404,
    );
    assert.strictEqual(db.tenant.rows[0].__updateCalls.length, 0);
  });

  it('a db failure on row.update PROPAGATES (not swallowed)', async () => {
    const db = buildDb({ tenants: [{ ...EXISTING }] });
    db.tenant.rows[0].update = async () => {
      throw new Error('tenant write failed');
    };
    await assert.rejects(
      () => TenantRepository.update('t-1', { ...FULL_UPDATE }, memberOptions(db)),
      /tenant write failed/,
    );
  });
});

// ═══════════════════════════ roleRepository ═════════════════════════════════
describe('crud-g12 · roleRepository.create', () => {
  const FULL_ROLE = {
    name: 'Jefe de Operaciones',
    slug: 'jefe-operaciones',
    description: 'Gestiona la operación diaria',
    permissions: ['stationRead', 'guardShiftRead'],
  };

  it('persists name/slug/description/permissions with tenant + audit ids', async () => {
    const db = buildDb();
    await RoleRepository.create({ ...FULL_ROLE }, repoOptions(db));
    assert.strictEqual(db.role.calls.create.length, 1);
    const written = db.role.calls.create[0];
    for (const [k, v] of Object.entries(FULL_ROLE)) {
      assert.deepStrictEqual(written[k], v, `field "${k}" was dropped or altered on create`);
    }
    assert.strictEqual(written.tenantId, TENANT);
    assert.strictEqual(written.createdById, USER_ID);
    assert.strictEqual(written.updatedById, USER_ID);
  });

  it('auto-slugifies the name when no slug is sent', async () => {
    const db = buildDb();
    await RoleRepository.create(
      { name: 'Supervisión Nocturna', permissions: [] },
      repoOptions(db),
    );
    assert.strictEqual(db.role.calls.create[0].slug, 'supervision-nocturna');
  });
});

describe('crud-g12 · roleRepository.update', () => {
  const CUSTOM_ROLE = {
    id: 'r-1',
    tenantId: TENANT,
    name: 'Custom',
    slug: 'custom',
    description: 'old',
    permissions: ['a'],
    isSystem: false,
    isCustomized: false,
    deletedAt: null,
  };

  it('targets {id, tenantId} and applies the full patch on a custom role', async () => {
    const db = buildDb({ roles: [{ ...CUSTOM_ROLE }] });
    await RoleRepository.update(
      'r-1',
      { name: 'Custom v2', slug: 'custom-v2', description: 'nueva', permissions: ['b', 'c'] },
      repoOptions(db),
    );

    const firstFind = db.role.calls.findOne[0];
    assert.strictEqual(firstFind.where.id, 'r-1');
    assert.strictEqual(firstFind.where.tenantId, TENANT);

    const patch = db.role.rows[0].__updateCalls[0];
    assert.strictEqual(patch.name, 'Custom v2');
    assert.strictEqual(patch.slug, 'custom-v2');
    assert.strictEqual(patch.description, 'nueva');
    assert.deepStrictEqual(patch.permissions, ['b', 'c']);
    assert.strictEqual(patch.updatedById, USER_ID);
  });

  it('system role: slug is immutable, permission edits persist and mark isCustomized', async () => {
    const db = buildDb({
      roles: [{ ...CUSTOM_ROLE, id: 'r-sys', slug: 'operator', isSystem: true }],
    });
    await RoleRepository.update(
      'r-sys',
      { slug: 'hacked-slug', permissions: ['x', 'y'] },
      repoOptions(db),
    );
    const row = db.role.rows[0];
    const patch = row.__updateCalls[0];
    assert.ok(!('slug' in patch), 'system-role slug must not be editable');
    assert.strictEqual(row.slug, 'operator');
    assert.deepStrictEqual(patch.permissions, ['x', 'y']);
    assert.strictEqual(patch.isCustomized, true, 'permission edit must mark the role customized');
  });

  it('the admin floor can never be removed from the admin role', async () => {
    const db = buildDb({
      roles: [{ ...CUSTOM_ROLE, id: 'r-adm', slug: 'admin', isSystem: true }],
    });
    await RoleRepository.update('r-adm', { permissions: [] }, repoOptions(db));
    const patch = db.role.rows[0].__updateCalls[0];
    for (const p of ADMIN_FLOOR_PERMISSIONS) {
      assert.ok(patch.permissions.includes(p), `floor permission "${p}" was removed`);
    }
  });

  it('fully-locked roles (customer) reject the update with Error400, nothing written', async () => {
    const db = buildDb({
      roles: [{ ...CUSTOM_ROLE, id: 'r-cust', slug: 'customer', isSystem: true }],
    });
    await assert.rejects(
      () => RoleRepository.update('r-cust', { permissions: ['p'] }, repoOptions(db)),
      (e: any) => e instanceof Error400,
    );
    assert.strictEqual(db.role.rows[0].__updateCalls.length, 0);
  });

  it("another tenant's role id gets Error404 and nothing is written", async () => {
    const db = buildDb({ roles: [{ ...CUSTOM_ROLE, tenantId: OTHER_TENANT }] });
    await assert.rejects(
      () => RoleRepository.update('r-1', { name: 'X' }, repoOptions(db)),
      (e: any) => e instanceof Error404,
    );
    assert.strictEqual(db.role.rows[0].__updateCalls.length, 0);
  });
});

describe('crud-g12 · roleRepository.resetToDefault / destroy', () => {
  it('resetToDefault restores the static defaults (+floor) and clears isCustomized', async () => {
    const db = buildDb({
      roles: [{
        id: 'r-adm', tenantId: TENANT, name: 'Admin', slug: 'admin',
        permissions: ['solo-una'], isSystem: true, isCustomized: true, deletedAt: null,
      }],
    });
    await RoleRepository.resetToDefault('r-adm', repoOptions(db));
    const patch = db.role.rows[0].__updateCalls[0];
    assert.strictEqual(patch.isCustomized, false);
    const expected = new Set([...getStaticDefaultsForRole('admin'), ...ADMIN_FLOOR_PERMISSIONS]);
    for (const p of expected) {
      assert.ok(patch.permissions.includes(p), `default permission "${p}" missing after reset`);
    }
  });

  it('resetToDefault on a non-system role is a 400 (no write)', async () => {
    const db = buildDb({
      roles: [{ id: 'r-1', tenantId: TENANT, slug: 'custom', isSystem: false, permissions: [], deletedAt: null }],
    });
    await assert.rejects(
      () => RoleRepository.resetToDefault('r-1', repoOptions(db)),
      (e: any) => e instanceof Error400,
    );
    assert.strictEqual(db.role.rows[0].__updateCalls.length, 0);
  });

  it('destroy refuses system roles', async () => {
    const db = buildDb({
      roles: [{ id: 'r-sys', tenantId: TENANT, slug: 'operator', isSystem: true, deletedAt: null }],
    });
    await assert.rejects(
      () => RoleRepository.destroy('r-sys', repoOptions(db)),
      (e: any) => e instanceof Error400,
    );
    assert.strictEqual(db.role.rows[0].__destroyed, false);
  });

  it('destroy refuses a custom role still assigned to a member', async () => {
    const db = buildDb({
      roles: [{ id: 'r-1', tenantId: TENANT, slug: 'custom', isSystem: false, deletedAt: null }],
    });
    db.tenantUser.findOne = async () => makeRow({ id: 'tu-1' }); // role in use
    await assert.rejects(
      () => RoleRepository.destroy('r-1', repoOptions(db)),
      (e: any) => e instanceof Error400,
    );
    assert.strictEqual(db.role.rows[0].__destroyed, false);
  });

  it('destroy removes an unused custom role', async () => {
    const db = buildDb({
      roles: [{ id: 'r-1', tenantId: TENANT, slug: 'custom', isSystem: false, deletedAt: null }],
    });
    db.tenantUser.findOne = async () => null;
    await RoleRepository.destroy('r-1', repoOptions(db));
    assert.strictEqual(db.role.rows[0].__destroyed, true);
  });
});

// ═══════════════════════════ department handlers ════════════════════════════
// The dupe-name probe uses Sequelize.where(fn(LOWER, col(name)), value) which the
// generic matcher can't evaluate — resolve it against row.name in lowercase.
function makeDeptDb(seed: any = {}) {
  const db = buildDb(seed);
  const base = db.department.findOne.bind(db.department);
  // Emulate MySQL's utf8mb4_unicode_ci collation for the name equality: the
  // handler now relies on a plain tenant-scoped `{ tenantId, name }` findOne
  // (indexed, case-insensitive on prod by collation), so the fake must match
  // names case-insensitively too.
  db.department.findOne = async (q: any = {}) => {
    const w = q && q.where;
    if (w && typeof w === 'object' && 'name' in w && 'tenantId' in w) {
      db.department.calls.findOne.push(q);
      const val = String(w.name || '').toLowerCase();
      return (
        db.department.rows.find(
          (r: any) =>
            !r.__destroyed &&
            r.tenantId === w.tenantId &&
            String(r.name || '').toLowerCase() === val,
        ) || null
      );
    }
    return base(q);
  };
  return db;
}

describe('crud-g12 · department handlers', () => {
  const FULL_DEPT = {
    name: '  Operaciones  ',
    description: 'Coordinación operativa de puestos',
    managerId: 'u-manager',
    active: false,
  };

  it('create persists every field (trimmed name) with tenant + audit ids', async () => {
    const db = makeDeptDb();
    const req = fakeReq(db, { body: { ...FULL_DEPT } });
    const res = fakeRes();
    await departmentCreate(req, res);

    assert.ok(res.statusCode < 400, `expected success, got ${res.statusCode}: ${JSON.stringify(res.body)}`);
    const written = db.department.calls.create[0];
    assert.strictEqual(written.name, 'Operaciones');
    assert.strictEqual(written.description, FULL_DEPT.description);
    assert.strictEqual(written.managerId, 'u-manager');
    assert.strictEqual(written.active, false);
    assert.strictEqual(written.tenantId, TENANT);
    assert.strictEqual(written.createdById, USER_ID);
    assert.strictEqual(written.updatedById, USER_ID);
  });

  it('create with a blank name is a 400 and writes nothing', async () => {
    const db = makeDeptDb();
    const req = fakeReq(db, { body: { name: '   ' } });
    const res = fakeRes();
    await departmentCreate(req, res);
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(db.department.calls.create.length, 0);
  });

  it('create rejects a same-tenant duplicate name (case-insensitive)', async () => {
    const db = makeDeptDb({
      departments: [{ id: 'd-1', tenantId: TENANT, name: 'Operaciones', deletedAt: null }],
    });
    const req = fakeReq(db, { body: { name: 'OPERACIONES' } });
    const res = fakeRes();
    await departmentCreate(req, res);
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(db.department.calls.create.length, 0);
  });

  // FIXED: departmentCreate's dupe probe is now tenant-scoped (findAll on
  // tenantId + case-insensitive name compare) — a foreign tenant sharing the
  // name can no longer mask an own-tenant duplicate.
  it('dupe guard must catch an own-tenant duplicate even when a foreign tenant shares the name', async () => {
    const db = makeDeptDb({
      departments: [
        { id: 'd-B', tenantId: OTHER_TENANT, name: 'Operaciones', deletedAt: null },
        { id: 'd-A', tenantId: TENANT, name: 'Operaciones', deletedAt: null },
      ],
    });
    const req = fakeReq(db, { body: { name: 'Operaciones' } });
    const res = fakeRes();
    await departmentCreate(req, res);
    assert.strictEqual(res.statusCode, 400, 'own-tenant duplicate slipped past the guard');
    assert.strictEqual(db.department.calls.create.length, 0);
  });

  it('a db failure on create surfaces as an error response, not a success', async () => {
    const db = makeDeptDb();
    db.department.create = async () => {
      throw new Error('dept write failed');
    };
    const req = fakeReq(db, { body: { name: 'Operaciones' } });
    const res = fakeRes();
    await departmentCreate(req, res);
    assert.ok(res.statusCode >= 500, `expected 5xx, got ${res.statusCode}`);
  });

  it('update targets {id, tenantId} and only touches the sent keys', async () => {
    const db = makeDeptDb({
      departments: [{
        id: 'd-1', tenantId: TENANT, name: 'Operaciones',
        description: 'keep-me', managerId: 'u-old', active: true, deletedAt: null,
      }],
    });
    const req = fakeReq(db, { params: { id: 'd-1' }, body: { name: 'Operaciones Norte', active: false } });
    const res = fakeRes();
    await departmentUpdate(req, res);

    assert.ok(res.statusCode < 400, JSON.stringify(res.body));
    const find = db.department.calls.findOne[0];
    assert.strictEqual(find.where.id, 'd-1');
    assert.strictEqual(find.where.tenantId, TENANT);

    const row = db.department.rows[0];
    const patch = row.__updateCalls[0];
    assert.strictEqual(patch.name, 'Operaciones Norte');
    assert.strictEqual(patch.active, false);
    assert.ok(!('description' in patch), 'unsent description must not be touched');
    assert.ok(!('managerId' in patch), 'unsent managerId must not be touched');
    assert.strictEqual(row.description, 'keep-me');
    assert.strictEqual(row.managerId, 'u-old');
  });

  it('update clears the manager when managerId is sent as null/empty', async () => {
    const db = makeDeptDb({
      departments: [{ id: 'd-1', tenantId: TENANT, name: 'Ops', managerId: 'u-old', active: true, deletedAt: null }],
    });
    const req = fakeReq(db, { params: { id: 'd-1' }, body: { managerId: '' } });
    const res = fakeRes();
    await departmentUpdate(req, res);
    assert.ok(res.statusCode < 400);
    assert.strictEqual(db.department.rows[0].managerId, null);
  });

  it("update on another tenant's department is a 404, nothing written", async () => {
    const db = makeDeptDb({
      departments: [{ id: 'd-1', tenantId: OTHER_TENANT, name: 'Ajeno', deletedAt: null }],
    });
    const req = fakeReq(db, { params: { id: 'd-1' }, body: { name: 'Robado' } });
    const res = fakeRes();
    await departmentUpdate(req, res);
    assert.strictEqual(res.statusCode, 404);
    assert.strictEqual(db.department.rows[0].__updateCalls.length, 0);
  });

  it('assignMember writes departmentId on the {tenantId, userId} membership', async () => {
    const db = makeDeptDb({
      departments: [{ id: 'd-1', tenantId: TENANT, name: 'Ops', active: true, deletedAt: null }],
      tenantUsers: [{ id: 'tu-1', tenantId: TENANT, userId: 'u-9', departmentId: null, deletedAt: null }],
    });
    const req = fakeReq(db, { params: { userId: 'u-9' }, body: { departmentId: 'd-1' } });
    const res = fakeRes();
    await departmentAssignMember(req, res);
    assert.ok(res.statusCode < 400, JSON.stringify(res.body));

    const find = db.tenantUser.calls.findOne[0];
    assert.strictEqual(find.where.tenantId, TENANT);
    assert.strictEqual(find.where.userId, 'u-9');
    assert.strictEqual(db.tenantUser.rows[0].departmentId, 'd-1');
  });

  it('assignMember rejects an inactive/foreign department with 400 and writes nothing', async () => {
    const db = makeDeptDb({
      departments: [{ id: 'd-1', tenantId: TENANT, name: 'Ops', active: false, deletedAt: null }],
      tenantUsers: [{ id: 'tu-1', tenantId: TENANT, userId: 'u-9', departmentId: null, deletedAt: null }],
    });
    const req = fakeReq(db, { params: { userId: 'u-9' }, body: { departmentId: 'd-1' } });
    const res = fakeRes();
    await departmentAssignMember(req, res);
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(db.tenantUser.rows[0].__updateCalls.length, 0);
  });

  it('assignMember with departmentId null unassigns', async () => {
    const db = makeDeptDb({
      tenantUsers: [{ id: 'tu-1', tenantId: TENANT, userId: 'u-9', departmentId: 'd-1', deletedAt: null }],
    });
    const req = fakeReq(db, { params: { userId: 'u-9' }, body: { departmentId: null } });
    const res = fakeRes();
    await departmentAssignMember(req, res);
    assert.ok(res.statusCode < 400);
    assert.strictEqual(db.tenantUser.rows[0].departmentId, null);
  });
});

// ═══════════════════════════ settings ═══════════════════════════════════════
describe('crud-g12 · settings save (SettingsService → settingsRepository)', () => {
  // Every JSON blob / column the Settings pages send (per the model definition).
  const FULL_SETTINGS = {
    theme: 'default',
    clientWelcomeEmailEnabled: false,
    emailPreferences: { dailyDigest: true, digestHour: 7 },
    emailBranding: { brandColor: '#c9a227' },
    notificationPreferences: { channels: { push: true, email: false } },
    mobileAppSettings: { accentColor: '#c9a227', appName: 'Mi Empresa', modules: { rondas: true } },
    guardSettings: { inactivityAlertMinutes: 30, shiftRemindersEnabled: true },
    postRules: { requireActiveShiftForRounds: true, geofenceExitAlerts: true },
    communicationSettings: { fallbackOrder: ['push', 'whatsapp', 'sms'] },
    nominaSettings: { lateGraceMinutes: 15, overtimeThresholdHours: 8 },
  };

  it('persists EVERY settings blob onto the tenant-scoped row (field fidelity)', async () => {
    const db = buildDb();
    await SettingsService.save({ ...FULL_SETTINGS }, repoOptions(db));

    const foc = db.settings.calls.findOrCreate[0];
    assert.strictEqual(foc.where.id, TENANT, 'settings row must be keyed by tenant id');
    assert.strictEqual(foc.where.tenantId, TENANT);

    const row = db.settings.rows[0];
    assert.ok(row.__updateCalls.length >= 1, 'settings.update was never called');
    const patch = row.__updateCalls[0];
    for (const [k, v] of Object.entries(FULL_SETTINGS)) {
      assert.deepStrictEqual(patch[k], v, `settings field "${k}" was dropped or altered on save`);
    }
    assert.strictEqual(db.__tx.commits, 1, 'settings save not committed');
  });

  it('a partial save does NOT clobber logoUrl/backgroundImageUrl (keys absent from the patch)', async () => {
    const db = buildDb({
      settings: [{
        id: TENANT, tenantId: TENANT, theme: 'default',
        logoUrl: 'https://cdn/logo.png', backgroundImageUrl: 'https://cdn/bg.png', deletedAt: null,
      }],
    });
    await SettingsService.save({ guardSettings: { inactivityAlertMinutes: 45 } }, repoOptions(db));
    const patch = db.settings.rows[0].__updateCalls[0];
    assert.ok(!('logoUrl' in patch), 'partial save must not recompute logoUrl');
    assert.ok(!('backgroundImageUrl' in patch), 'partial save must not recompute backgroundImageUrl');
    assert.strictEqual(db.settings.rows[0].logoUrl, 'https://cdn/logo.png');
  });

  it('saving logos derives logoUrl and writes all three file relations', async () => {
    const db = buildDb();
    const logos = [{ id: 'f-logo', downloadUrl: 'https://cdn/nuevo-logo.png' }];
    const backgroundImages = [{ id: 'f-bg', downloadUrl: 'https://cdn/bg.png' }];
    const legalDocuments = [{ id: 'f-doc', name: 'ruc.pdf' }];
    await SettingsService.save(
      { theme: 'default', logos, backgroundImages, legalDocuments },
      repoOptions(db),
    );

    const patch = db.settings.rows[0].__updateCalls[0];
    assert.strictEqual(patch.logoUrl, 'https://cdn/nuevo-logo.png');
    assert.strictEqual(patch.backgroundImageUrl, 'https://cdn/bg.png');
    assert.ok(!('logos' in patch), 'virtual logos field must not hit the column write');

    const stub = FileRepository.replaceRelationFiles as sinon.SinonStub;
    const cols = stub.getCalls().map((c) => c.args[0].belongsToColumn);
    assert.ok(cols.includes('logos'), 'logos relation not written');
    assert.ok(cols.includes('backgroundImages'), 'backgroundImages relation not written');
    assert.ok(cols.includes('legalDocuments'), 'legalDocuments relation not written');
    const logosCall = stub.getCalls().find((c) => c.args[0].belongsToColumn === 'logos');
    assert.deepStrictEqual(logosCall!.args[1], logos);
  });

  it('a db failure rolls back and rethrows (never a fake success)', async () => {
    const db = buildDb({
      settings: [{ id: TENANT, tenantId: TENANT, theme: 'default', deletedAt: null }],
    });
    db.settings.rows[0].update = async () => {
      throw new Error('settings write failed');
    };
    await assert.rejects(
      () => SettingsService.save({ theme: 'dark' }, repoOptions(db)),
      /settings write failed/,
    );
    assert.strictEqual(db.__tx.rollbacks, 1, 'transaction not rolled back');
  });
});
