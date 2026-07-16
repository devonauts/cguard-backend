/**
 * Unit tests — CRUD persistence fidelity for the g03-guards module group:
 *   securityGuard, guardDevice, guardRating, certification, licenseType, insurance
 *   (+ guardLicense, the write model behind /security-guard/:id/licenses).
 *
 * The tenant reports "things are not being saved". These tests call the REAL
 * repository/service/handler write functions against an in-memory Sequelize-shaped
 * fake db (same style as tests/unit/attendance) and assert:
 *   1. FIELD FIDELITY — every writable field the frontend can send reaches the
 *      model's create()/update() call with the right value (nothing silently
 *      dropped by a pick/whitelist).
 *   2. TARGETING — update() resolves the row via where { id, tenantId } (no
 *      cross-tenant writes, no lost patches).
 *   3. NO SWALLOWED ERRORS — a db failure surfaces as a rejection / error
 *      response, never a fake success.
 *
 * Run:
 *   cross-env NODE_ENV=test TS_NODE_PROJECT=tsconfig.test.json \
 *     npx mocha -r ts-node/register \
 *     'tests/unit/crud-g03-guards/**' + '/*.test.ts' --exit --timeout 20000
 */

import assert from 'assert';
import Sequelize from 'sequelize';

import CertificationRepository from '../../../src/database/repositories/certificationRepository';
import InsuranceRepository from '../../../src/database/repositories/insuranceRepository';
import LicenseTypeRepository from '../../../src/database/repositories/licenseTypeRepository';
import GuardLicenseRepository from '../../../src/database/repositories/guardLicenseRepository';
import SecurityGuardRepository from '../../../src/database/repositories/securityGuardRepository';
import {
  registerGuardDevice,
  resetGuardBinding,
} from '../../../src/services/guardDeviceService';
import { customerGuardRatingCreate } from '../../../src/api/customer/customerGuardRatings';

const Op = Sequelize.Op;

const TENANT = 'tenant-A';
const OTHER_TENANT = 'tenant-B';
const ADMIN = {
  id: 'admin-1',
  email: 'admin@empresa.ec',
  tenants: [{ tenant: { id: TENANT }, status: 'active', roles: ['admin'] }],
};

// ──────────────────────── fake rows / models (Sequelize-shaped) ──────────────
function makeRow(data: any) {
  const row: any = {
    updateCalls: [] as any[],
    setMemosCalls: [] as any[],
    setRequestsCalls: [] as any[],
    setTutorialesCalls: [] as any[],
    destroyed: false,
    get(opts?: any) {
      const plain: any = {};
      for (const k of Object.keys(data)) plain[k] = data[k];
      return plain;
    },
    async update(patch: any, _opts?: any) {
      row.updateCalls.push(patch);
      Object.assign(data, patch);
      Object.assign(row, patch);
      return row;
    },
    async destroy(_opts?: any) {
      row.destroyed = true;
    },
    async restore(_opts?: any) {},
    // association getters the repos' findById/_fill paths touch — all empty.
    getImage: async () => [],
    getIcon: async () => [],
    getDocument: async () => [],
    getFrontImage: async () => [],
    getBackImage: async () => [],
    getProfileImage: async () => [],
    getCredentialImage: async () => [],
    getRecordPolicial: async () => [],
    getMemos: async () => [],
    getRequests: async () => [],
    getTutoriales: async () => [],
    async setMemos(v: any) { row.setMemosCalls.push(v); },
    async setRequests(v: any) { row.setRequestsCalls.push(v); },
    async setTutoriales(v: any) { row.setTutorialesCalls.push(v); },
  };
  Object.assign(row, data);
  return row;
}

/** Minimal Sequelize where matcher: plain equality, null, Op.or/and/in/notIn/ne. */
function rowMatches(row: any, where: any): boolean {
  if (!where) return true;
  for (const key of Reflect.ownKeys(where)) {
    const val = (where as any)[key];
    if (typeof key === 'symbol') {
      if (key === Op.or) {
        if (!(val as any[]).some((c) => rowMatches(row, c))) return false;
      } else if (key === Op.and) {
        const arr = Array.isArray(val) ? val : [val];
        if (!arr.every((c) => rowMatches(row, c))) return false;
      }
      continue; // other top-level ops ignored
    }
    if (val === null) {
      if (row[key] != null) return false;
      continue;
    }
    if (val && typeof val === 'object' && !Array.isArray(val) && !(val instanceof Date)) {
      const syms = Object.getOwnPropertySymbols(val);
      if (syms.length) {
        for (const s of syms) {
          const opVal = (val as any)[s];
          if (s === Op.in) {
            if (!opVal.map(String).includes(String(row[key]))) return false;
          } else if (s === Op.notIn) {
            if (opVal.map(String).includes(String(row[key]))) return false;
          } else if (s === Op.ne) {
            if (String(row[key]) === String(opVal)) return false;
          } else if (s === Op.not) {
            if (opVal === null && row[key] == null) return false;
          }
          // gte/lte etc. not needed on the tested paths
        }
        continue;
      }
    }
    if (row[key] !== val) return false;
  }
  return true;
}

function makeModel(name: string, seedRows: any[] = []) {
  const m: any = {
    _name: name,
    rows: seedRows.map(makeRow),
    creates: [] as any[],
    findOneWheres: [] as any[],
    bulkUpdates: [] as any[],
    async create(payload: any, _opts?: any) {
      m.creates.push(payload);
      const row = makeRow({ id: payload.id || `${name}-${m.rows.length + 1}`, ...payload });
      m.rows.push(row);
      return row;
    },
    async findOne(q: any = {}) {
      m.findOneWheres.push(q.where);
      return m.rows.find((r: any) => !r.destroyed && rowMatches(r, q.where)) || null;
    },
    async findAll(q: any = {}) {
      return m.rows.filter((r: any) => !r.destroyed && rowMatches(r, q.where));
    },
    async findByPk(id: any, _o?: any) {
      return m.rows.find((r: any) => String(r.id) === String(id)) || null;
    },
    async findAndCountAll(q: any = {}) {
      const rows = m.rows.filter((r: any) => !r.destroyed && rowMatches(r, q.where));
      return { rows, count: rows.length };
    },
    async count(q: any = {}) {
      return m.rows.filter((r: any) => rowMatches(r, q.where)).length;
    },
    async update(patch: any, q: any) {
      m.bulkUpdates.push({ patch, where: q && q.where });
      let n = 0;
      for (const r of m.rows) {
        if (rowMatches(r, q && q.where)) { await r.update(patch); n++; }
      }
      return [n];
    },
    getTableName: () => `${name}s`,
  };
  return m;
}

/** Fake db with every model the g03 write paths touch. */
function buildDb(seed: { [model: string]: any[] } = {}) {
  const modelNames = [
    'certification', 'insurance', 'licenseType', 'guardLicense', 'securityGuard',
    'user', 'tenantUser', 'businessInfo', 'file', 'auditLog', 'deviceIdInformation',
    'guardRating', 'station', 'guardShift', 'securityEvent', 'platformEvent',
  ];
  const db: any = {
    Sequelize,
    sequelize: { transaction: async () => ({ commit: async () => {}, rollback: async () => {} }) },
  };
  for (const n of modelNames) db[n] = makeModel(n, seed[n] || []);
  return db;
}

function makeOptions(db: any, over: any = {}) {
  return {
    database: db,
    currentUser: ADMIN,
    currentTenant: { id: TENANT },
    language: 'es',
    ...over,
  } as any;
}

/** Assert that `received` (a create/update payload) carries every k:v of `expected`. */
function assertFields(received: any, expected: Record<string, any>, ctx: string) {
  for (const [k, v] of Object.entries(expected)) {
    assert.deepStrictEqual(
      received[k],
      v,
      `${ctx}: field "${k}" expected ${JSON.stringify(v)} but the db write got ${JSON.stringify(received[k])}`,
    );
  }
}

// ═════════════════════════════ certification ════════════════════════════════
describe('crud-g03 · certification (CertificationRepository)', () => {
  const FULL = {
    title: 'Curso de Vigilancia',
    code: 'VIG-001',
    description: 'Certificación anual de vigilancia privada',
    acquisitionDate: '2026-01-10',
    expirationDate: '2027-01-10',
    importHash: 'imp-hash-cert',
    image: [{ id: 'f-img', new: true, name: 'cert.png', sizeInBytes: 10, publicUrl: 'https://cdn/cert.png', privateUrl: null }],
    icon: [{ id: 'f-ico', new: true, name: 'icon.png', sizeInBytes: 5, publicUrl: 'https://cdn/icon.png', privateUrl: null }],
  };

  it('create persists EVERY writable field (+ derived imageUrl/iconUrl + tenant/audit ids)', async () => {
    const db = buildDb();
    await CertificationRepository.create({ ...FULL }, makeOptions(db));

    assert.strictEqual(db.certification.creates.length, 1, 'exactly one INSERT');
    assertFields(db.certification.creates[0], {
      title: FULL.title,
      code: FULL.code,
      description: FULL.description,
      acquisitionDate: FULL.acquisitionDate,
      expirationDate: FULL.expirationDate,
      importHash: FULL.importHash,
      imageUrl: 'https://cdn/cert.png',
      iconUrl: 'https://cdn/icon.png',
      tenantId: TENANT,
      createdById: ADMIN.id,
      updatedById: ADMIN.id,
    }, 'certification.create');

    // the two uploads become file rows bound to the right columns
    const cols = db.file.creates.map((c: any) => c.belongsToColumn).sort();
    assert.deepStrictEqual(cols, ['icon', 'image']);
  });

  it('update targets where {id, tenantId} and applies the full patch', async () => {
    const db = buildDb({
      certification: [{ id: 'cert-1', tenantId: TENANT, title: 'Viejo', code: 'OLD' }],
    });
    await CertificationRepository.update('cert-1', { ...FULL }, makeOptions(db));

    const where = db.certification.findOneWheres[0];
    assert.strictEqual(where.id, 'cert-1');
    assert.strictEqual(where.tenantId, TENANT, 'update lookup must be tenant-scoped');

    const row = db.certification.rows[0];
    assert.ok(row.updateCalls.length >= 1, 'row.update must be called');
    assertFields(row.updateCalls[0], {
      title: FULL.title,
      code: FULL.code,
      description: FULL.description,
      acquisitionDate: FULL.acquisitionDate,
      expirationDate: FULL.expirationDate,
      importHash: FULL.importHash,
      updatedById: ADMIN.id,
    }, 'certification.update');
    assert.strictEqual(row.title, FULL.title, 'patch actually applied to the row');
  });

  it("update of another tenant's record throws 404 (never a cross-tenant write)", async () => {
    const db = buildDb({
      certification: [{ id: 'cert-x', tenantId: OTHER_TENANT, title: 'Ajena' }],
    });
    await assert.rejects(
      CertificationRepository.update('cert-x', { title: 'Robada' }, makeOptions(db)),
      (e: any) => e.code === 404,
    );
    assert.strictEqual(db.certification.rows[0].updateCalls.length, 0);
  });

  it('a db INSERT failure propagates (not swallowed into success)', async () => {
    const db = buildDb();
    db.certification.create = async () => { throw new Error('DB down'); };
    await assert.rejects(
      CertificationRepository.create({ ...FULL }, makeOptions(db)),
      /DB down/,
    );
  });

  // FIXED: CertificationRepository.update now presence-guards imageUrl/iconUrl —
  // they are only recomputed when the payload actually carries image/icon, so a
  // partial update no longer nulls the stored legacy columns.
  it('update WITHOUT image/icon in the payload preserves stored imageUrl/iconUrl', async () => {
    const db = buildDb({
      certification: [{ id: 'cert-1', tenantId: TENANT, title: 'Viejo', imageUrl: 'https://cdn/keep.png', iconUrl: 'https://cdn/keep-ico.png' }],
    });
    await CertificationRepository.update('cert-1', { title: 'Nuevo' }, makeOptions(db));
    const row = db.certification.rows[0];
    assert.strictEqual(row.imageUrl, 'https://cdn/keep.png');
    assert.strictEqual(row.iconUrl, 'https://cdn/keep-ico.png');
  });
});

// ═══════════════════════════════ insurance ══════════════════════════════════
describe('crud-g03 · insurance (InsuranceRepository)', () => {
  const FULL = {
    provider: 'Seguros Equinoccial',
    policyNumber: 'POL-2026-778',
    validFrom: '2026-01-01',
    validUntil: '2026-12-31',
    importHash: 'imp-hash-ins',
    document: [{ id: 'f-doc', new: true, name: 'poliza.pdf', sizeInBytes: 100, publicUrl: 'https://cdn/poliza.pdf', privateUrl: null }],
  };

  it('create persists EVERY writable field', async () => {
    const db = buildDb();
    await InsuranceRepository.create({ ...FULL }, makeOptions(db));

    assert.strictEqual(db.insurance.creates.length, 1);
    assertFields(db.insurance.creates[0], {
      provider: FULL.provider,
      policyNumber: FULL.policyNumber,
      validFrom: FULL.validFrom,
      validUntil: FULL.validUntil,
      importHash: FULL.importHash,
      tenantId: TENANT,
      createdById: ADMIN.id,
      updatedById: ADMIN.id,
    }, 'insurance.create');
    assert.strictEqual(db.file.creates[0].belongsToColumn, 'document');
  });

  it('update targets where {id, tenantId} and applies the full patch', async () => {
    const db = buildDb({
      insurance: [{ id: 'ins-1', tenantId: TENANT, provider: 'Antiguo' }],
    });
    await InsuranceRepository.update('ins-1', { ...FULL }, makeOptions(db));

    const where = db.insurance.findOneWheres[0];
    assert.strictEqual(where.id, 'ins-1');
    assert.strictEqual(where.tenantId, TENANT);

    const row = db.insurance.rows[0];
    assertFields(row.updateCalls[0], {
      provider: FULL.provider,
      policyNumber: FULL.policyNumber,
      validFrom: FULL.validFrom,
      validUntil: FULL.validUntil,
      importHash: FULL.importHash,
      updatedById: ADMIN.id,
    }, 'insurance.update');
  });

  it('update of a missing/foreign row throws 404', async () => {
    const db = buildDb({ insurance: [{ id: 'ins-b', tenantId: OTHER_TENANT }] });
    await assert.rejects(
      InsuranceRepository.update('ins-b', { provider: 'X' }, makeOptions(db)),
      (e: any) => e.code === 404,
    );
  });

  it('a db UPDATE failure propagates (not swallowed)', async () => {
    const db = buildDb({ insurance: [{ id: 'ins-1', tenantId: TENANT }] });
    db.insurance.rows[0].update = async () => { throw new Error('deadlock'); };
    await assert.rejects(
      InsuranceRepository.update('ins-1', { provider: 'X' }, makeOptions(db)),
      /deadlock/,
    );
  });
});

// ══════════════════════════════ licenseType ═════════════════════════════════
describe('crud-g03 · licenseType (LicenseTypeRepository)', () => {
  it('create persists name + status + importHash + tenant/audit ids', async () => {
    const db = buildDb();
    await LicenseTypeRepository.create(
      { name: 'Licencia de conducir tipo E', status: 'inactive', importHash: 'lt-hash' },
      makeOptions(db),
    );
    assertFields(db.licenseType.creates[0], {
      name: 'Licencia de conducir tipo E',
      status: 'inactive',
      importHash: 'lt-hash',
      tenantId: TENANT,
      createdById: ADMIN.id,
      updatedById: ADMIN.id,
    }, 'licenseType.create');
  });

  it('update targets where {id, tenantId} and applies name/status', async () => {
    const db = buildDb({ licenseType: [{ id: 'lt-1', tenantId: TENANT, name: 'Vieja', status: 'active' }] });
    await LicenseTypeRepository.update('lt-1', { name: 'Nueva', status: 'inactive' }, makeOptions(db));

    const where = db.licenseType.findOneWheres[0];
    assert.strictEqual(where.id, 'lt-1');
    assert.strictEqual(where.tenantId, TENANT);
    assertFields(db.licenseType.rows[0].updateCalls[0], {
      name: 'Nueva',
      status: 'inactive',
      updatedById: ADMIN.id,
    }, 'licenseType.update');
  });

  it('cross-tenant update throws 404', async () => {
    const db = buildDb({ licenseType: [{ id: 'lt-b', tenantId: OTHER_TENANT, name: 'Ajena' }] });
    await assert.rejects(
      LicenseTypeRepository.update('lt-b', { name: 'Robada' }, makeOptions(db)),
      (e: any) => e.code === 404,
    );
  });
});

// ═════════════════ guardLicense (/security-guard/:id/licenses) ══════════════
describe('crud-g03 · guardLicense (GuardLicenseRepository)', () => {
  const FULL = {
    guardId: 'sg-1',
    licenseTypeId: 'lt-1',
    customName: 'Permiso porte de armas',
    number: 'ARM-556677',
    issueDate: '2026-02-01',
    expiryDate: '2028-02-01',
    importHash: 'gl-hash',
    frontImage: [{ id: 'f-front', new: true, name: 'front.jpg', sizeInBytes: 9, publicUrl: 'https://cdn/front.jpg', privateUrl: null }],
    backImage: [{ id: 'f-back', new: true, name: 'back.jpg', sizeInBytes: 9, publicUrl: 'https://cdn/back.jpg', privateUrl: null }],
  };

  it('create persists EVERY writable field (incl. guardId FK)', async () => {
    const db = buildDb();
    await GuardLicenseRepository.create({ ...FULL }, makeOptions(db));

    assertFields(db.guardLicense.creates[0], {
      guardId: 'sg-1',
      licenseTypeId: 'lt-1',
      customName: FULL.customName,
      number: FULL.number,
      issueDate: FULL.issueDate,
      expiryDate: FULL.expiryDate,
      importHash: FULL.importHash,
      tenantId: TENANT,
      createdById: ADMIN.id,
      updatedById: ADMIN.id,
    }, 'guardLicense.create');

    const cols = db.file.creates.map((c: any) => c.belongsToColumn).sort();
    assert.deepStrictEqual(cols, ['backImage', 'frontImage']);
  });

  it('update targets where {id, tenantId}, applies the patch, and never re-parents guardId', async () => {
    const db = buildDb({
      guardLicense: [{ id: 'gl-1', tenantId: TENANT, guardId: 'sg-1', number: 'OLD' }],
    });
    await GuardLicenseRepository.update(
      'gl-1',
      { ...FULL, guardId: 'sg-EVIL' }, // attempt to move the license to another guard
      makeOptions(db),
    );

    const where = db.guardLicense.findOneWheres[0];
    assert.strictEqual(where.id, 'gl-1');
    assert.strictEqual(where.tenantId, TENANT);

    const patch = db.guardLicense.rows[0].updateCalls[0];
    assertFields(patch, {
      licenseTypeId: 'lt-1',
      customName: FULL.customName,
      number: FULL.number,
      issueDate: FULL.issueDate,
      expiryDate: FULL.expiryDate,
      importHash: FULL.importHash,
      updatedById: ADMIN.id,
    }, 'guardLicense.update');
    assert.ok(!('guardId' in patch), 'guardId must NOT be re-parented via update');
    assert.strictEqual(db.guardLicense.rows[0].guardId, 'sg-1');
  });

  it('update of a foreign-tenant license throws 404', async () => {
    const db = buildDb({ guardLicense: [{ id: 'gl-b', tenantId: OTHER_TENANT, guardId: 'sg-9' }] });
    await assert.rejects(
      GuardLicenseRepository.update('gl-b', { number: 'X' }, makeOptions(db)),
      (e: any) => e.code === 404,
    );
  });
});

// ══════════════════════════════ securityGuard ═══════════════════════════════
describe('crud-g03 · securityGuard (SecurityGuardRepository)', () => {
  /** Every scalar the CRM create/edit form can send (per model + repo pick list). */
  const FULL = {
    governmentId: '1712345678',
    fullName: 'Carlos Prueba',
    hiringContractDate: '2026-01-15T10:00:00Z', // full ISO — must be normalized to DATEONLY
    gender: 'Masculino',
    isOnDuty: false,
    bloodType: 'O+',
    guardCredentials: 'Credencial 123',
    birthDate: '1990-05-20',
    birthPlace: 'Quito',
    maritalStatus: 'Casado',
    academicInstruction: 'Secundaria',
    address: 'Av. Amazonas N34-451',
    importHash: 'sg-hash',
    availability: { lunes: ['08:00-16:00'] },
    languages: ['es', 'en'],
    skills: ['vigilancia', 'primeros auxilios'],
    guardType: 'sacafranco',
    workRules: { maxConsecutiveDays: 6 },
    guard: 'user-9', // linked user id → guardId
  };

  it('create persists EVERY writable field (+ guardId, normalized DATEONLYs, tenant/audit ids)', async () => {
    const db = buildDb(); // user-9 does not exist → fullName from payload is kept
    await SecurityGuardRepository.create({ ...FULL }, makeOptions(db));

    assert.strictEqual(db.securityGuard.creates.length, 1);
    assertFields(db.securityGuard.creates[0], {
      governmentId: FULL.governmentId,
      fullName: FULL.fullName,
      hiringContractDate: '2026-01-15', // ISO datetime coerced to YYYY-MM-DD
      gender: FULL.gender,
      isOnDuty: false,
      bloodType: FULL.bloodType,
      guardCredentials: FULL.guardCredentials,
      birthDate: '1990-05-20',
      birthPlace: FULL.birthPlace,
      maritalStatus: FULL.maritalStatus,
      academicInstruction: FULL.academicInstruction,
      address: FULL.address,
      importHash: FULL.importHash,
      availability: FULL.availability,
      languages: FULL.languages,
      skills: FULL.skills,
      guardType: FULL.guardType,
      workRules: FULL.workRules,
      guardId: 'user-9',
      tenantId: TENANT,
      createdById: ADMIN.id,
      updatedById: ADMIN.id,
    }, 'securityGuard.create');
  });

  it('create derives fullName from the LINKED USER when one exists (denormalized cache)', async () => {
    const db = buildDb({ user: [{ id: 'user-9', fullName: 'María Verdadera' }] });
    await SecurityGuardRepository.create({ ...FULL, fullName: 'Nombre Del Form' }, makeOptions(db));
    assert.strictEqual(db.securityGuard.creates[0].fullName, 'María Verdadera');
  });

  it('create coerces a blank hiringContractDate to null instead of crashing the DATEONLY insert', async () => {
    const db = buildDb();
    await SecurityGuardRepository.create({ ...FULL, hiringContractDate: '  ' }, makeOptions(db));
    assert.strictEqual(db.securityGuard.creates[0].hiringContractDate, null);
  });

  it('update targets where {id, tenantId} and applies every edited field', async () => {
    const db = buildDb({
      securityGuard: [{
        id: 'sg-1', tenantId: TENANT, guardId: null, fullName: 'Carlos Prueba',
        gender: 'Masculino', address: 'Vieja dirección',
      }],
    });
    const { guard, ...scalars } = FULL; // no linked user → no identity derive
    await SecurityGuardRepository.update('sg-1', { ...scalars, address: 'Calle Nueva 123' }, makeOptions(db));

    const where = db.securityGuard.findOneWheres[0];
    assert.strictEqual(where.id, 'sg-1');
    assert.strictEqual(where.tenantId, TENANT, 'update lookup must be tenant-scoped');

    const patch = db.securityGuard.rows[0].updateCalls[0];
    assertFields(patch, {
      governmentId: FULL.governmentId,
      hiringContractDate: '2026-01-15',
      gender: FULL.gender,
      isOnDuty: false,
      bloodType: FULL.bloodType,
      guardCredentials: FULL.guardCredentials,
      birthDate: '1990-05-20',
      birthPlace: FULL.birthPlace,
      maritalStatus: FULL.maritalStatus,
      academicInstruction: FULL.academicInstruction,
      address: 'Calle Nueva 123',
      importHash: FULL.importHash,
      availability: FULL.availability,
      languages: FULL.languages,
      skills: FULL.skills,
      guardType: FULL.guardType,
      workRules: FULL.workRules,
      updatedById: ADMIN.id,
    }, 'securityGuard.update');
  });

  it('update coerces empty-string enum-ish fields to null (partially-completed draft saves)', async () => {
    const db = buildDb({
      securityGuard: [{ id: 'sg-1', tenantId: TENANT, guardId: null, fullName: 'Draft Guy' }],
    });
    await SecurityGuardRepository.update(
      'sg-1',
      { gender: '', bloodType: ' ', maritalStatus: '', academicInstruction: '', governmentId: '' },
      makeOptions(db),
    );
    const patch = db.securityGuard.rows[0].updateCalls[0];
    assert.strictEqual(patch.gender, null);
    assert.strictEqual(patch.bloodType, null);
    assert.strictEqual(patch.maritalStatus, null);
    assert.strictEqual(patch.academicInstruction, null);
    assert.strictEqual(patch.governmentId, null);
  });

  it('update with guard:null does NOT clobber the existing guardId FK', async () => {
    const db = buildDb({
      securityGuard: [{ id: 'sg-1', tenantId: TENANT, guardId: 'user-1', fullName: 'Juan' }],
      user: [{ id: 'user-1', fullName: 'Juan Pérez', email: 'juan@x.com' }],
    });
    await SecurityGuardRepository.update('sg-1', { address: 'X', guard: null }, makeOptions(db));
    const patch = db.securityGuard.rows[0].updateCalls[0];
    assert.ok(!('guardId' in patch), 'guardId must be absent from the patch when guard:null');
    assert.strictEqual(db.securityGuard.rows[0].guardId, 'user-1');
  });

  it('update propagates identity edits (name/email/phone) to the LINKED USER and re-syncs fullName', async () => {
    const db = buildDb({
      securityGuard: [{ id: 'sg-1', tenantId: TENANT, guardId: 'user-1', fullName: 'Juan Pérez' }],
      user: [{ id: 'user-1', fullName: 'Juan Pérez', email: 'juan@x.com', phoneNumber: '' }],
    });
    await SecurityGuardRepository.update(
      'sg-1',
      { fullName: 'Juan Renombrado', email: 'nuevo@x.com', phoneNumber: '+593991234567' },
      makeOptions(db),
    );

    const userPatch = db.user.rows[0].updateCalls[0];
    assertFields(userPatch, {
      fullName: 'Juan Renombrado',
      firstName: 'Juan',
      lastName: 'Renombrado',
      email: 'nuevo@x.com',
      phoneNumber: '+593991234567',
    }, 'linked user identity patch');

    // and the denormalized cache on securityGuard follows the fresh user value
    const sgPatch = db.securityGuard.rows[0].updateCalls[0];
    assert.strictEqual(sgPatch.fullName, 'Juan Renombrado');
  });

  it('update rejects an email already owned by ANOTHER account (Error400, write aborted)', async () => {
    const db = buildDb({
      securityGuard: [{ id: 'sg-1', tenantId: TENANT, guardId: 'user-1', fullName: 'Juan Pérez' }],
      user: [
        { id: 'user-1', fullName: 'Juan Pérez', email: 'juan@x.com' },
        { id: 'user-2', fullName: 'Otra Persona', email: 'tomado@x.com' },
      ],
    });
    await assert.rejects(
      SecurityGuardRepository.update('sg-1', { email: 'tomado@x.com' }, makeOptions(db)),
      (e: any) => e.code === 400,
    );
    assert.strictEqual(db.securityGuard.rows[0].updateCalls.length, 0, 'guard row must not be written');
  });

  it('cross-tenant update throws 404 and writes nothing', async () => {
    const db = buildDb({
      securityGuard: [{ id: 'sg-b', tenantId: OTHER_TENANT, guardId: null, fullName: 'Ajeno' }],
    });
    await assert.rejects(
      SecurityGuardRepository.update('sg-b', { address: 'Hack' }, makeOptions(db)),
      (e: any) => e.code === 404,
    );
    assert.strictEqual(db.securityGuard.rows[0].updateCalls.length, 0);
  });

  it('a db UPDATE failure propagates (not swallowed)', async () => {
    const db = buildDb({
      securityGuard: [{ id: 'sg-1', tenantId: TENANT, guardId: null, fullName: 'Juan' }],
    });
    db.securityGuard.rows[0].update = async () => { throw new Error('lock wait timeout'); };
    await assert.rejects(
      SecurityGuardRepository.update('sg-1', { address: 'X' }, makeOptions(db)),
      /lock wait timeout/,
    );
  });

  describe('patchUpdate (PATCH /security-guard/:id)', () => {
    it('applies ONLY the provided fields and stamps updatedById', async () => {
      const db = buildDb({
        securityGuard: [{ id: 'sg-1', tenantId: TENANT, guardId: null, fullName: 'Juan', gender: 'Masculino', address: 'Vieja' }],
      });
      await SecurityGuardRepository.patchUpdate('sg-1', { address: 'Nueva 42', birthPlace: 'Loja' }, makeOptions(db));

      const where = db.securityGuard.findOneWheres[0];
      assert.strictEqual(where.id, 'sg-1');
      assert.strictEqual(where.tenantId, TENANT);

      const patch = db.securityGuard.rows[0].updateCalls[0];
      assert.strictEqual(patch.address, 'Nueva 42');
      assert.strictEqual(patch.birthPlace, 'Loja');
      assert.strictEqual(patch.updatedById, ADMIN.id);
      assert.ok(!('gender' in patch), 'untouched fields stay out of the patch');
      // associations untouched when absent from the payload
      assert.strictEqual(db.securityGuard.rows[0].setMemosCalls.length, 0);
    });

    // FIXED: securityGuardRepository.patchUpdate's `allowed` whitelist now includes
    // 'guardType', 'workRules' and 'availability' (matching the full update() pick
    // list and the PATCH handler), so a PATCH changing guard type / work rules /
    // availability is persisted instead of silently dropped.
    it('applies guardType / workRules / availability sent via PATCH', async () => {
      const db = buildDb({
        securityGuard: [{ id: 'sg-1', tenantId: TENANT, guardId: null, fullName: 'Juan', guardType: 'titular' }],
      });
      await SecurityGuardRepository.patchUpdate(
        'sg-1',
        { guardType: 'sacafranco', workRules: { maxConsecutiveDays: 5 }, availability: { lunes: ['08:00-16:00'] } },
        makeOptions(db),
      );
      const patch = db.securityGuard.rows[0].updateCalls[0];
      assert.strictEqual(patch.guardType, 'sacafranco');
      assert.deepStrictEqual(patch.workRules, { maxConsecutiveDays: 5 });
      assert.deepStrictEqual(patch.availability, { lunes: ['08:00-16:00'] });
    });
  });
});

// ══════════════════════════════ guardDevice ═════════════════════════════════
describe('crud-g03 · guardDevice (guardDeviceService)', () => {
  const INPUT = {
    deviceId: 'dev-abc-123',
    platform: 'android',
    model: 'Pixel 7',
    manufacturer: 'Google',
    osVersion: '14',
    appVersion: '2.3.1',
    pushToken: 'fcm-token-xyz',
  };

  it('first report CREATES the device with EVERY field and binds it', async () => {
    const db = buildDb();
    const r = await registerGuardDevice(db, TENANT, 'user-1', { ...INPUT });

    assertFields(db.deviceIdInformation.creates[0], {
      deviceId: 'dev-abc-123',
      tenantId: TENANT,
      userId: 'user-1',
      app: 'worker',
      platform: 'android',
      model: 'Pixel 7',
      manufacturer: 'Google',
      osVersion: '14',
      appVersion: '2.3.1',
      pushToken: 'fcm-token-xyz',
      createdById: 'user-1',
      updatedById: 'user-1',
    }, 'deviceIdInformation.create');
    assert.ok(db.deviceIdInformation.creates[0].lastSeenAt instanceof Date);

    assert.strictEqual(r.bound, true);
    assert.strictEqual(r.mismatch, false);
    const row = db.deviceIdInformation.rows[0];
    assert.strictEqual(row.isBound, true, 'first device must be bound');
  });

  it('re-report UPDATES the existing row and does NOT clobber pushToken when absent', async () => {
    const db = buildDb({
      deviceIdInformation: [{
        id: 'dev-row-1', deviceId: 'dev-abc-123', tenantId: TENANT, userId: 'user-1',
        isBound: true, flagged: false, pushToken: 'fcm-token-xyz',
      }],
    });
    const r = await registerGuardDevice(db, TENANT, 'user-1', {
      deviceId: 'dev-abc-123', platform: 'android', model: 'Pixel 7',
      // NO pushToken this time (app resume without a fresh token)
    });

    assert.strictEqual(db.deviceIdInformation.creates.length, 0, 'must not duplicate the device row');
    const patch = db.deviceIdInformation.rows[0].updateCalls[0];
    assert.ok(!('pushToken' in patch), 'absent pushToken must not be written (would null the FCM token)');
    assert.strictEqual(db.deviceIdInformation.rows[0].pushToken, 'fcm-token-xyz', 'token survives');
    assert.strictEqual(r.bound, true);
  });

  it('a DIFFERENT device than the bound one is recorded + flagged (never blocked)', async () => {
    const db = buildDb({
      deviceIdInformation: [{
        id: 'dev-row-1', deviceId: 'dev-abc-123', tenantId: TENANT, userId: 'user-1',
        isBound: true, flagged: false,
      }],
    });
    const r = await registerGuardDevice(db, TENANT, 'user-1', { deviceId: 'dev-OTHER-999', model: 'iPhone 15' });

    assert.strictEqual(r.mismatch, true);
    assert.strictEqual(r.bound, false);
    const newRow = db.deviceIdInformation.rows.find((x: any) => x.deviceId === 'dev-OTHER-999');
    assert.ok(newRow, 'the new device row must still be persisted');
    assert.strictEqual(newRow.flagged, true);
    assert.ok(newRow.lastMismatchAt instanceof Date);
    // the bound device stays bound
    assert.strictEqual(db.deviceIdInformation.rows[0].isBound, true);
  });

  it('a missing deviceId is rejected with 400 (no silent no-op write)', async () => {
    const db = buildDb();
    await assert.rejects(
      registerGuardDevice(db, TENANT, 'user-1', { deviceId: '  ' } as any),
      (e: any) => e.code === 400,
    );
    assert.strictEqual(db.deviceIdInformation.creates.length, 0);
  });

  it("resetGuardBinding unbinds ALL of the guard's devices scoped by {tenantId, userId}", async () => {
    const db = buildDb({
      deviceIdInformation: [
        { id: 'dev-row-1', deviceId: 'd1', tenantId: TENANT, userId: 'user-1', isBound: true, flagged: false },
        { id: 'dev-row-2', deviceId: 'd2', tenantId: TENANT, userId: 'user-1', isBound: false, flagged: true },
      ],
    });
    const r = await resetGuardBinding(db, TENANT, 'dev-row-1', 'admin-1');

    assert.strictEqual(r.userId, 'user-1');
    assert.strictEqual(r.cleared, 2);
    const bulk = db.deviceIdInformation.bulkUpdates[0];
    assert.deepStrictEqual(bulk.where, { tenantId: TENANT, userId: 'user-1' });
    assertFields(bulk.patch, { isBound: false, flagged: false, updatedById: 'admin-1' }, 'reset patch');
    assert.strictEqual(db.deviceIdInformation.rows[0].isBound, false);
    assert.strictEqual(db.deviceIdInformation.rows[1].flagged, false);
  });
});

// ══════════════════════════ guardRating (customer write) ════════════════════
describe('crud-g03 · guardRating (customerGuardRatingCreate — the only write path)', () => {
  function makeRes() {
    const r: any = {
      statusCode: null,
      body: null,
      status(c: number) { r.statusCode = c; return r; },
      send(b: any) { r.body = b; return r; },
      json(b: any) { r.body = b; return r; },
      sendStatus(c: number) { r.statusCode = c; return r; },
      header() { return r; },
    };
    return r;
  }

  function ratingDb() {
    return buildDb({
      securityGuard: [{ id: 'sg-1', guardId: 'user-1', tenantId: TENANT, fullName: 'Juan Pérez' }],
      station: [{ id: 'st-1', tenantId: TENANT, stationOriginId: 'client-1' }],
      guardShift: [{ id: 'shift-1', tenantId: TENANT, guardNameId: 'sg-1', stationNameId: 'st-1' }],
    });
  }

  function makeReq(db: any, body: any, guardIdParam = 'sg-1') {
    return {
      database: db,
      currentUser: { id: 'cust-user-1', clientAccountId: 'client-1', tenantId: TENANT },
      currentTenant: { id: TENANT },
      params: { guardId: guardIdParam },
      body,
      language: 'es',
    } as any;
  }

  it('persists EVERY field of a new rating (resolved guard PK, verified shift/station)', async () => {
    const db = ratingDb();
    const res = makeRes();
    await customerGuardRatingCreate(makeReq(db, { rating: 4, comment: '  Muy atento  ' }), res);

    assert.strictEqual(res.statusCode, 200, `expected success, got ${res.statusCode}: ${JSON.stringify(res.body)}`);
    assert.strictEqual(res.body.success, true);
    assertFields(db.guardRating.creates[0], {
      clientAccountId: 'client-1',
      guardId: 'sg-1',
      stationId: 'st-1',   // backfilled from the verified shift
      shiftId: 'shift-1',
      rating: 4,
      comment: 'Muy atento', // trimmed
      tenantId: TENANT,
      createdById: 'cust-user-1',
      updatedById: 'cust-user-1',
    }, 'guardRating.create');
  });

  it('accepts the linked USER id in the URL and still stores the securityGuard PK', async () => {
    const db = ratingDb();
    const res = makeRes();
    await customerGuardRatingCreate(makeReq(db, { rating: 5 }, 'user-1'), res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(db.guardRating.creates[0].guardId, 'sg-1');
  });

  it('re-rating UPDATES the existing row (rating + comment) instead of stacking a duplicate', async () => {
    const db = ratingDb();
    db.guardRating = makeModel('guardRating', [{
      id: 'rate-1', clientAccountId: 'client-1', guardId: 'sg-1', tenantId: TENANT, rating: 2, comment: 'Regular',
    }]);
    const res = makeRes();
    await customerGuardRatingCreate(makeReq(db, { rating: 5, comment: 'Mejoró muchísimo' }), res);

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(db.guardRating.creates.length, 0, 'no duplicate row');
    const patch = db.guardRating.rows[0].updateCalls[0];
    assertFields(patch, {
      rating: 5,
      comment: 'Mejoró muchísimo',
      stationId: 'st-1',
      shiftId: 'shift-1',
      updatedById: 'cust-user-1',
    }, 'guardRating re-rate');
    assert.strictEqual(db.guardRating.rows[0].rating, 5);
  });

  it('a db INSERT failure returns an ERROR response — never {success:true}', async () => {
    const db = ratingDb();
    db.guardRating.create = async () => { throw new Error('DB exploded'); };
    const res = makeRes();
    await customerGuardRatingCreate(makeReq(db, { rating: 3 }), res);

    assert.notStrictEqual(res.statusCode, 200, 'db failure must not answer 200');
    assert.ok(!res.body || res.body.success !== true, 'db failure must not report success');
  });

  it('rejects a rating for a guard with NO shift at any of the client stations (403)', async () => {
    const db = ratingDb();
    db.guardShift = makeModel('guardShift', []); // never worked for this client
    const res = makeRes();
    await customerGuardRatingCreate(makeReq(db, { rating: 5 }), res);
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(db.guardRating.creates.length, 0);
  });

  it('rejects an out-of-range rating and writes nothing', async () => {
    const db = ratingDb();
    const res = makeRes();
    await customerGuardRatingCreate(makeReq(db, { rating: 9 }), res);
    assert.notStrictEqual(res.statusCode, 200);
    assert.strictEqual(db.guardRating.creates.length, 0);
  });
});
