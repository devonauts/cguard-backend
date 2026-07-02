/**
 * Backfill: grant the `supervisorMe` permission to CUSTOMIZED built-in supervisor
 * roles that predate it.
 *
 * `supervisorMe` gates every /supervisor/me/* endpoint (clock-in/out, routes).
 * The code assigns it to admin / operationsManager / securitySupervisor, but a
 * tenant that CUSTOMIZED one of those roles has an authoritative DB permission
 * snapshot that was frozen before `supervisorMe` existed — so their supervisors
 * get 403 on clock-in. Non-customized roles fall back to the static map and are
 * fine, so we only touch customized rows that are missing it.
 *
 * Run:  npx ts-node scripts/20260701-backfill-supervisorMe-permission.ts
 */
require('dotenv').config();

import models from '../src/database/models';

const TARGET_SLUGS = ['securitySupervisor', 'operationsManager', 'admin'];
const ADD = ['supervisorMe'];

async function run() {
  const db: any = models();
  const roles = await db.role.findAll({ where: { slug: TARGET_SLUGS } });

  let fixed = 0;
  let alreadyOk = 0;
  let staticOk = 0;

  for (const r of roles) {
    let perms: string[] = r.permissions as any;
    if (!Array.isArray(perms)) {
      try { perms = JSON.parse((perms as any) || '[]'); } catch { perms = []; }
    }
    const missing = ADD.filter((p) => !perms.includes(p));
    const tag = `slug=${r.slug} tenant=${r.tenantId} customized=${r.isCustomized} nperms=${perms.length}`;

    if (missing.length === 0) {
      alreadyOk++;
      continue;
    }
    if (!r.isCustomized) {
      // Non-customized → static map already grants it; nothing to persist.
      staticOk++;
      continue;
    }
    await r.update({ permissions: [...perms, ...missing] });
    fixed++;
    console.log(`FIXED  ${tag}  +[${missing.join(',')}]`);
  }

  console.log(
    `\nDONE  fixed=${fixed}  already-had-it=${alreadyOk}  non-customized(static)=${staticOk}  total=${roles.length}`,
  );

  // Show the demo tenant's supervisor role explicitly for verification.
  const demo = await db.role.findOne({
    where: { tenantId: '0dca7da5-f994-434c-b255-9bcbdcb22a55', slug: 'securitySupervisor' },
  });
  if (demo) {
    let dp: any = demo.permissions;
    if (!Array.isArray(dp)) { try { dp = JSON.parse(dp || '[]'); } catch { dp = []; } }
    console.log(
      `DEMO securitySupervisor: customized=${demo.isCustomized} hasSupervisorMe=${dp.includes('supervisorMe')}`,
    );
  } else {
    console.log('DEMO securitySupervisor: no customized row (uses static map → already OK)');
  }

  process.exit(0);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
