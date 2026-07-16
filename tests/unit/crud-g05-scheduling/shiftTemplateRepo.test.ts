/**
 * CRUD persistence tests — shiftTemplate (Programador · Plantillas de turno).
 *
 * Field-fidelity net over ShiftTemplateRepository: every writable field of the
 * template form must reach the INSERT/UPDATE, updates must target {id, tenantId},
 * a partial patch must keep stored values, an explicit null/'' must CLEAR the
 * field (that's how the admin removes a guard/nota), and db failures propagate.
 *
 * Run:
 *   cross-env NODE_ENV=test TS_NODE_PROJECT=tsconfig.test.json \
 *     npx mocha -r ts-node/register \
 *     'tests/unit/crud-g05-scheduling/**\/*.test.ts' --exit --timeout 20000
 */

import assert from 'assert';

import ShiftTemplateRepository from '../../../src/database/repositories/shiftTemplateRepository';
import Error404 from '../../../src/errors/Error404';

const TENANT = 'aaaaaaaa-0000-0000-0000-0000000000aa';
const OTHER_TENANT = 'bbbbbbbb-0000-0000-0000-0000000000bb';
const USER_ID = 'user-admin-1';

const ADMIN_USER = {
  id: USER_ID,
  email: 'admin@test.dev',
  emailVerified: true,
  tenants: [{ tenant: { id: TENANT }, status: 'active', roles: ['admin'] }],
};

function makeRow(data: any) {
  const row: any = {
    ...data,
    _updates: [] as any[],
    _destroyed: false,
    get(opts?: any) {
      void opts;
      return { ...data };
    },
    async update(patch: any) {
      row._updates.push({ ...patch });
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined) continue; // Sequelize skips undefined keys
        data[k] = v;
        row[k] = v;
      }
      return row;
    },
    async destroy() {
      row._destroyed = true;
    },
  };
  return row;
}

function buildDb(seed: { templates?: any[] } = {}) {
  const rows = (seed.templates || []).map(makeRow);
  const createCalls: any[] = [];
  const findOneCalls: any[] = [];
  const audits: any[] = [];

  const db: any = {
    rows,
    createCalls,
    findOneCalls,
    audits,
    shiftTemplate: {
      async create(payload: any) {
        createCalls.push({ ...payload });
        const row = makeRow({ id: `tpl-new-${createCalls.length}`, ...payload });
        rows.push(row);
        return row;
      },
      async findOne({ where }: any) {
        findOneCalls.push({ ...where });
        return (
          rows.find(
            (r: any) =>
              (where.id === undefined || r.id === where.id) &&
              (where.tenantId === undefined || r.tenantId === where.tenantId),
          ) || null
        );
      },
    },
    auditLog: {
      async create(entry: any) {
        audits.push(entry);
        return makeRow({ id: `audit-${audits.length}`, ...entry });
      },
    },
  };
  return db;
}

function options(db: any) {
  return {
    language: 'en',
    currentUser: ADMIN_USER,
    currentTenant: { id: TENANT },
    database: db,
  } as any;
}

/** Every writable field of the template form. */
function fullPayload() {
  return {
    templateName: 'Turno Diurno 12h',
    startTime: '07:00',
    endTime: '19:00',
    repeatShift: 'weekly',
    repeatBy: 'monday',
    postSiteId: 'ps-1',
    guardId: 'g-1',
    skillSet: 'armado',
    department: 'Operaciones',
    breakDuration: '30',
    note: 'Plantilla estándar de día',
    category: 'seguridad',
    status: 'active',
  };
}

describe('crud-g05 · shiftTemplate repository', () => {
  describe('create — field fidelity', () => {
    it('persists EVERY writable field with the exact value the caller sent', async () => {
      const db = buildDb();
      const data = fullPayload();

      await ShiftTemplateRepository.create(data, options(db));

      assert.strictEqual(db.createCalls.length, 1, 'exactly one INSERT');
      const p = db.createCalls[0];
      for (const [k, v] of Object.entries(data)) {
        assert.deepStrictEqual(p[k], v, `field "${k}" must reach the INSERT unchanged`);
      }
      assert.strictEqual(p.tenantId, TENANT);
      assert.strictEqual(p.createdById, USER_ID);
      assert.strictEqual(p.updatedById, USER_ID);

      assert.strictEqual(db.audits.length, 1);
      assert.strictEqual(db.audits[0].action, 'create');
      assert.strictEqual(db.audits[0].entityName, 'shiftTemplate');
    });

    it('defaults status to "active" when the form omits it', async () => {
      const db = buildDb();
      const data: any = fullPayload();
      delete data.status;
      await ShiftTemplateRepository.create(data, options(db));
      assert.strictEqual(db.createCalls[0].status, 'active');
    });

    it('does NOT swallow a db failure into a success (INSERT error propagates)', async () => {
      const db = buildDb();
      db.shiftTemplate.create = async () => {
        throw new Error('ER_NO_SUCH_TABLE: shiftTemplates');
      };
      await assert.rejects(
        () => ShiftTemplateRepository.create(fullPayload(), options(db)),
        /ER_NO_SUCH_TABLE/,
      );
      assert.strictEqual(db.audits.length, 0, 'no audit log on a failed write');
    });
  });

  describe('update — targets the right row and applies the whole patch', () => {
    function seedRow(overrides: any = {}) {
      return { id: 'tpl-1', tenantId: TENANT, ...fullPayload(), ...overrides };
    }

    it('looks the row up by id AND tenantId (tenant-scoped where)', async () => {
      const db = buildDb({ templates: [seedRow()] });
      await ShiftTemplateRepository.update('tpl-1', { note: 'x' }, options(db));
      const where = db.findOneCalls[0];
      assert.strictEqual(where.id, 'tpl-1');
      assert.strictEqual(where.tenantId, TENANT);
    });

    it('applies EVERY writable field of the patch to the row', async () => {
      const db = buildDb({ templates: [seedRow()] });
      const patchData = {
        templateName: 'Turno Nocturno 12h',
        startTime: '19:00',
        endTime: '07:00',
        repeatShift: 'daily',
        repeatBy: 'friday',
        postSiteId: 'ps-2',
        guardId: 'g-2',
        skillSet: 'canino',
        department: 'Nocturno',
        breakDuration: '45',
        note: 'EDITADA',
        category: 'vigilancia',
        status: 'inactive',
      };

      await ShiftTemplateRepository.update('tpl-1', patchData, options(db));

      const row = db.rows[0];
      assert.strictEqual(row._updates.length, 1);
      for (const [k, v] of Object.entries(patchData)) {
        assert.strictEqual(row[k], v, `field "${k}" must be applied to the row`);
      }
      assert.strictEqual(row._updates[0].updatedById, USER_ID);
      assert.strictEqual(db.audits.length, 1);
      assert.strictEqual(db.audits[0].action, 'update');
    });

    it('a PARTIAL patch (note only) keeps every other stored value untouched', async () => {
      const db = buildDb({ templates: [seedRow()] });
      await ShiftTemplateRepository.update('tpl-1', { note: 'solo la nota' }, options(db));
      const row = db.rows[0];
      assert.strictEqual(row.note, 'solo la nota');
      assert.strictEqual(row.templateName, 'Turno Diurno 12h');
      assert.strictEqual(row.startTime, '07:00');
      assert.strictEqual(row.endTime, '19:00');
      assert.strictEqual(row.postSiteId, 'ps-1');
      assert.strictEqual(row.guardId, 'g-1', 'guardId must survive a partial update');
      assert.strictEqual(row.department, 'Operaciones');
      assert.strictEqual(row.status, 'active');
    });

    it('an EXPLICIT clear (guardId:null, note:"") persists the clear instead of reverting', async () => {
      const db = buildDb({ templates: [seedRow()] });
      await ShiftTemplateRepository.update('tpl-1', { guardId: null, note: '' }, options(db));
      const row = db.rows[0];
      assert.strictEqual(row.guardId, null, 'removed guard must stay removed');
      assert.strictEqual(row.note, null, 'cleared note must persist as null');
      assert.strictEqual(row.templateName, 'Turno Diurno 12h', 'untouched fields stay');
    });

    it('404s (does not silently no-op) when the id belongs to ANOTHER tenant', async () => {
      const db = buildDb({ templates: [seedRow({ tenantId: OTHER_TENANT })] });
      await assert.rejects(
        () => ShiftTemplateRepository.update('tpl-1', { note: 'x' }, options(db)),
        Error404,
      );
      assert.strictEqual(db.rows[0]._updates.length, 0, 'foreign row must not be touched');
    });

    it('does NOT swallow a db failure on update (error propagates)', async () => {
      const db = buildDb({ templates: [seedRow()] });
      db.rows[0].update = async () => {
        throw new Error('Lock wait timeout exceeded');
      };
      await assert.rejects(
        () => ShiftTemplateRepository.update('tpl-1', fullPayload(), options(db)),
        /Lock wait timeout/,
      );
    });
  });

  describe('destroy', () => {
    it('destroys the tenant-scoped row and audits a snapshot', async () => {
      const db = buildDb({ templates: [{ id: 'tpl-1', tenantId: TENANT, templateName: 'X', startTime: '07:00', endTime: '19:00' }] });
      await ShiftTemplateRepository.destroy('tpl-1', options(db));
      assert.strictEqual(db.rows[0]._destroyed, true);
      assert.strictEqual(db.findOneCalls[0].tenantId, TENANT);
      assert.strictEqual(db.audits.length, 1);
      assert.strictEqual(db.audits[0].action, 'delete');
      assert.strictEqual(db.audits[0].values.templateName, 'X', 'audit keeps the pre-delete snapshot');
    });

    it('404s for a row of another tenant instead of deleting it', async () => {
      const db = buildDb({ templates: [{ id: 'tpl-1', tenantId: OTHER_TENANT }] });
      await assert.rejects(() => ShiftTemplateRepository.destroy('tpl-1', options(db)), Error404);
      assert.strictEqual(db.rows[0]._destroyed, false);
    });
  });
});
