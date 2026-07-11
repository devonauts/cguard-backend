/**
 * Backfill the new `staffMe` permission into every existing tenant's frozen
 * role snapshots. New code permissions don't reach existing tenants because a
 * non-empty DB `roles.permissions` snapshot wins over the static defaults
 * (see memory rbac-new-permission-propagation). Grants staffMe to the same
 * roles the static map does: office + management.
 *
 * Idempotent. Users must RE-LOGIN afterwards (effective set is baked at signin).
 * Run: npx ts-node scripts/20260711-backfill-staffMe-permission.ts
 */
require('dotenv').config();

import models from '../src/database/models';

const PERMISSION = 'staffMe';
const TARGET_SLUGS = [
  'administrativeSupervisor', 'administrativeAssistant', 'secretary',
  'admin', 'operationsManager', 'hrManager', 'clientAccountManager', 'dispatcher',
];

async function run() {
  const db: any = models();
  const roles = await db.role.findAll({ where: { slug: TARGET_SLUGS } });
  let changed = 0;
  for (const role of roles) {
    let perms: string[] = [];
    const raw = role.permissions;
    if (Array.isArray(raw)) perms = raw.slice();
    else if (typeof raw === 'string') { try { perms = JSON.parse(raw); } catch { perms = []; } }
    if (!Array.isArray(perms)) perms = [];
    if (perms.length === 0) continue; // empty snapshot → static defaults already include it
    if (perms.includes(PERMISSION)) continue;
    perms.push(PERMISSION);
    await role.update({ permissions: perms });
    changed++;
    console.log(`  + staffMe → role ${role.slug} (tenant ${role.tenantId})`);
  }
  console.log(`Backfill complete: ${changed} role row(s) updated across all tenants.`);
  process.exit(0);
}

run().catch((e) => { console.error('Backfill failed:', e); process.exit(1); });
