/**
 * Lazy-seed of the 20 default incident types (first-touch catalog bootstrap).
 *
 * Covers ensureDefaultIncidentTypes — the function incidentTypeList calls before
 * every list so a virgin tenant gets the standard taxonomy out of the box:
 *   - virgin tenant  → all 20 canonical names seeded (active, tenant-scoped, audited)
 *   - existing tenant → no-op (idempotent; findOrCreate never double-inserts)
 *   - soft-deleted rows count as "has had types" (a deliberate wipe is respected)
 *   - best-effort: a db failure never throws (returns false)
 *   - tenant isolation: each tenant's virgin check is scoped to its own id
 *
 * Run:
 *   cross-env NODE_ENV=test TS_NODE_PROJECT=tsconfig.test.json npx mocha \
 *     -r ts-node/register 'tests/unit/op-incidentes-eventos/**\/*.test.ts' --exit --timeout 20000
 */
import assert from 'assert';
import {
  ensureDefaultIncidentTypes,
  DEFAULT_INCIDENT_TYPES,
} from '../../../src/services/incidentTypeDefaults';
import { buildDb, TENANT, OTHER_TENANT, USER_ID } from './helpers';

describe('op-incidentes · incidentType lazy-seed (ensureDefaultIncidentTypes)', () => {
  it('seeds EXACTLY the 20 canonical names for a virgin tenant', async () => {
    const db = buildDb();
    const seeded = await ensureDefaultIncidentTypes(db, TENANT, USER_ID);

    assert.strictEqual(seeded, true);
    assert.strictEqual(DEFAULT_INCIDENT_TYPES.length, 20, 'catalog must be 20 entries');
    assert.strictEqual(db.incidentType.rows.length, 20, 'expected 20 types created');

    const names = db.incidentType.rows.map((r: any) => r.name).sort();
    assert.deepStrictEqual(names, [...DEFAULT_INCIDENT_TYPES].sort());
    // Canonical Spanish taxonomy the mobile apps resolve labels against.
    const set = new Set(names);
    assert.ok(set.has('Robo / hurto'));
    assert.ok(set.has('Emergencia médica'));
    assert.ok(set.has('Otro'));
  });

  it('every seeded type is active, tenant-scoped and stamped with the creator', async () => {
    const db = buildDb();
    await ensureDefaultIncidentTypes(db, TENANT, USER_ID);
    for (const row of db.incidentType.rows) {
      assert.strictEqual(row.active, true, `${row.name} not active`);
      assert.strictEqual(row.tenantId, TENANT, `${row.name} not scoped to tenant`);
      assert.strictEqual(row.createdById, USER_ID, `${row.name} missing createdById`);
    }
  });

  it('does NOT re-seed a tenant that already has types (idempotent no-op)', async () => {
    const db = buildDb({
      incidentTypes: [
        { id: 'it-1', tenantId: TENANT, name: 'Robo / hurto', active: true, deletedAt: null },
      ],
    });
    const seeded = await ensureDefaultIncidentTypes(db, TENANT, USER_ID);
    assert.strictEqual(seeded, false, 'must not seed when types already exist');
    assert.strictEqual(db.incidentType.calls.findOrCreate.length, 0, 'no seeding attempted');
    assert.strictEqual(db.incidentType.rows.length, 1, 'existing catalog untouched');
  });

  it('running the seed twice does not double-insert (findOrCreate dedupe)', async () => {
    const db = buildDb();
    await ensureDefaultIncidentTypes(db, TENANT, USER_ID);
    assert.strictEqual(db.incidentType.rows.length, 20);
    // Second call: count>0 now, so it short-circuits and inserts nothing more.
    const again = await ensureDefaultIncidentTypes(db, TENANT, USER_ID);
    assert.strictEqual(again, false);
    assert.strictEqual(db.incidentType.rows.length, 20, 'must stay at 20, no duplicates');
  });

  it('respects a deliberate wipe: soft-deleted rows count as "has had types"', async () => {
    // paranoid:false count includes soft-deleted rows → a tenant that deleted
    // their catalog is left alone, not re-seeded from under them.
    const db = buildDb({
      incidentTypes: [
        {
          id: 'it-old',
          tenantId: TENANT,
          name: 'Robo / hurto',
          active: true,
          deletedAt: new Date('2026-01-01'),
        },
      ],
    });
    const seeded = await ensureDefaultIncidentTypes(db, TENANT, USER_ID);
    assert.strictEqual(seeded, false, 'soft-deleted history must block re-seeding');
    assert.strictEqual(db.incidentType.calls.findOrCreate.length, 0);
  });

  it('is best-effort: a db failure returns false and never throws', async () => {
    const db = buildDb();
    db.incidentType.count = async () => {
      throw new Error('db down');
    };
    const seeded = await ensureDefaultIncidentTypes(db, TENANT, USER_ID);
    assert.strictEqual(seeded, false, 'must swallow the error and report no seed');
  });

  it('the virgin check is tenant-scoped (tenant A seeding does not see tenant B rows)', async () => {
    // tenant B already owns types; tenant A is virgin. Seeding A must still fire.
    const db = buildDb({
      incidentTypes: [
        { id: 'itB', tenantId: OTHER_TENANT, name: 'Robo / hurto', active: true, deletedAt: null },
      ],
    });
    const seeded = await ensureDefaultIncidentTypes(db, TENANT, USER_ID);
    assert.strictEqual(seeded, true, 'tenant A is virgin and must be seeded');
    const aRows = db.incidentType.rows.filter((r: any) => r.tenantId === TENANT);
    assert.strictEqual(aRows.length, 20);
  });

  it('handles a null creator (system seed) without failing', async () => {
    const db = buildDb();
    const seeded = await ensureDefaultIncidentTypes(db, TENANT, null);
    assert.strictEqual(seeded, true);
    assert.strictEqual(db.incidentType.rows.length, 20);
    assert.strictEqual(db.incidentType.rows[0].createdById, null);
  });
});
