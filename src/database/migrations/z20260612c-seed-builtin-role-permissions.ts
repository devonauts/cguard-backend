require('dotenv').config();

import models from '../models';
import Roles from '../../security/roles';
import { getStaticDefaultsForRole } from '../../security/staticRolePermissions';
import { ensureBuiltInRoles } from '../../services/roleSync';

/**
 * RBAC overhaul (PR-1) — backfill built-in role rows with their static default
 * permissions and mark them isSystem=true, for tenants created before the
 * defaults seeding existed (rows were previously created with permissions:[]).
 *
 * Idempotent + safe:
 *   - ensureBuiltInRoles findOrCreate's any MISSING built-in rows (with defaults).
 *   - For EXISTING rows: set isSystem, and set permissions to static defaults
 *     ONLY where currently empty/null — never clobber a non-empty (possibly
 *     already-customized) permission set.
 */
const NON_TENANT_ROLES = new Set(['superadmin', 'custom']);

async function migrate() {
  const { sequelize } = models();
  const db: any = sequelize.models;

  try {
    // 1) Ensure built-in rows exist for every tenant (seeds defaults + isSystem).
    await ensureBuiltInRoles(db);

    // 2) Backfill existing rows.
    const builtInKeys = Object.keys(Roles.values || {}).filter(
      (k) => !NON_TENANT_ROLES.has(k),
    );
    let updated = 0;
    for (const slug of builtInKeys) {
      const rows = await db.role.findAll({ where: { slug } });
      for (const row of rows) {
        const perms = row.permissions;
        const isEmpty = !perms || (Array.isArray(perms) && perms.length === 0);
        const patch: any = {};
        if (row.isSystem !== true) patch.isSystem = true;
        if (isEmpty) patch.permissions = getStaticDefaultsForRole(slug);
        if (Object.keys(patch).length) {
          await row.update(patch);
          updated++;
        }
      }
    }
    console.log(`✅ Built-in role permissions backfilled (${updated} row(s) updated).`);
    process.exit(0);
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  }
}

export { migrate };

migrate();
