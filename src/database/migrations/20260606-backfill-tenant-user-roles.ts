/**
 * One-off backfill: populate the tenantUserRoles join (C6) for tenantUsers that
 * already existed before the on-write sync was wired. Reads each tenantUser's
 * serialized `roles` string-array and ensures a tenantUserRoles row per role.
 * Idempotent (syncTenantUserRoleRows uses findOrCreate).
 *
 * Run: npx ts-node src/database/migrations/20260606-backfill-tenant-user-roles.ts
 */
require('dotenv').config();

import models from '../models';
import { syncTenantUserRoleRows } from '../../services/roleSync';

(async () => {
  const db = models();
  const tenantUsers = await db.tenantUser.findAll({ where: { deletedAt: null } });
  let ok = 0;
  for (const tu of tenantUsers) {
    try {
      await syncTenantUserRoleRows(db, tu);
      ok++;
    } catch (e: any) {
      console.error('skip tenantUser', tu.id, e?.message || e);
    }
  }
  console.log(`✅ backfilled tenantUserRoles for ${ok}/${tenantUsers.length} tenantUsers`);
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
