/**
 * Prepare an EXISTING dummy guard in a tenant for worker-app testing:
 *   - sets the guard user's password (default: Ecuador2025) + emailVerified
 *   - ensures the tenant membership has the `securityGuard` role
 *   - ensures the guard is assigned to a station (assigns the first one if not)
 *   - prints the login credentials
 *
 * Run with the backend's DB environment:
 *   npx ts-node src/database/migrations/prepare-test-guard.ts
 *
 * Env overrides:
 *   SEED_TENANT_NAME  tenant name prefix   default: "Seguridad BAS"
 *   GUARD_PASSWORD    password to set      default: "Ecuador2025"
 *   GUARD_EMAIL       pick a specific guard by email (optional)
 */
require('dotenv').config();

import { Op } from 'sequelize';
import models from '../models';
import bcrypt from 'bcryptjs';

async function run() {
  const db = models();
  const tenantName = process.env.SEED_TENANT_NAME || 'Seguridad BAS';
  const password = process.env.GUARD_PASSWORD || 'Ecuador2025';
  const pinnedEmail = process.env.GUARD_EMAIL?.toLowerCase();

  // 1) Tenant
  const tenant = await db.tenant.findOne({
    where: { name: { [Op.like]: `${tenantName}%` } },
  });
  if (!tenant) {
    const all = await db.tenant.findAll({ attributes: ['id', 'name'], limit: 50 });
    console.error(`❌ No tenant matching "${tenantName}". Tenants:`);
    all.forEach((t: any) => console.error(`   - ${t.name} (${t.id})`));
    process.exit(1);
  }
  console.log(`✔ Tenant: ${tenant.name} (${tenant.id})`);

  // 2) Find a dummy guard that has a linked login user.
  const guards = await db.securityGuard.findAll({
    where: { tenantId: tenant.id, deletedAt: null, guardId: { [Op.ne]: null } },
    limit: 200,
  });
  if (!guards.length) {
    console.error('❌ No securityGuard records with a linked user in this tenant.');
    process.exit(1);
  }

  let chosen: any = null;
  let user: any = null;
  for (const g of guards) {
    const u = await db.user.findOne({ where: { id: g.guardId } });
    if (!u) continue;
    if (pinnedEmail && u.email?.toLowerCase() !== pinnedEmail) continue;
    chosen = g;
    user = u;
    break;
  }
  if (!chosen || !user) {
    console.error('❌ Could not find a guard with a usable login user.');
    process.exit(1);
  }
  console.log(`✔ Guard: ${chosen.fullName} <${user.email}>`);

  // 3) Password + verified
  await user.update({ password: bcrypt.hashSync(password, 8), emailVerified: true });
  console.log('• Password set + email verified.');

  // 4) securityGuard role on the tenant membership
  const membership = await db.tenantUser.findOne({
    where: { userId: user.id, tenantId: tenant.id },
  });
  if (membership) {
    const roles: string[] = Array.isArray(membership.roles) ? membership.roles : [];
    if (!roles.includes('securityGuard')) {
      await membership.update({ roles: [...roles, 'securityGuard'], status: 'active' });
      console.log('• Added securityGuard role.');
    } else {
      console.log('• Membership already has securityGuard role.');
    }
  } else {
    await db.tenantUser.create({
      userId: user.id,
      tenantId: tenant.id,
      roles: ['securityGuard'],
      status: 'active',
    });
    console.log('• Created tenant membership with securityGuard role.');
  }

  // 5) Ensure assigned to a station
  const assigned = await (chosen.constructor as any).sequelize.models.station.findAll({
    where: { tenantId: tenant.id, deletedAt: null },
    include: [{
      model: db.user,
      as: 'assignedGuards',
      where: { id: user.id },
      attributes: ['id'],
      through: { attributes: [] },
      required: true,
    }],
  });
  let stationName: string;
  if (assigned.length) {
    stationName = assigned[0].stationName;
    console.log(`• Already assigned to: ${stationName}`);
  } else {
    const station = await db.station.findOne({
      where: { tenantId: tenant.id, deletedAt: null },
    });
    if (!station) {
      console.warn('⚠ No stations in tenant — guard left unassigned (create a station first).');
      stationName = '(none — no stations exist)';
    } else {
      await station.addAssignedGuard(user);
      stationName = station.stationName;
      console.log(`• Assigned to station: ${stationName}`);
    }
  }

  console.log('\n✅ Ready. Worker-app login:');
  console.log('   Email:   ', user.email);
  console.log('   Password:', password);
  console.log('   Tenant:  ', tenant.name);
  console.log('   Station: ', stationName);
  process.exit(0);
}

run().catch((err: any) => {
  if (err && err.errors) {
    console.error('Validation error:', err.errors.map((e: any) => `${e.path}: ${e.message}`).join('; '));
  } else {
    console.error(err);
  }
  process.exit(1);
});
