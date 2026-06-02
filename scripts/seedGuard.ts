/**
 * Seeder: create a test SECURITY GUARD user for the worker app.
 *
 * It creates (or reuses) the user, associates it to a tenant with the
 * `securityGuard` role, and creates the matching `securityGuard` record so the
 * guard endpoints (/tenant/:id/guard/me) resolve correctly.
 *
 * Run it with the backend's DB environment:
 *   npx ts-node src/database/migrations/seedGuard.ts
 *
 * Configurable via env vars:
 *   SEED_TENANT_NAME   tenant name (prefix match)   default: "Seguridad Bas"
 *   GUARD_EMAIL        guard login email            default: "guardia.demo@cguardpro.com"
 *   GUARD_PASSWORD     guard login password         default: "GuardiaDemo1234@"
 *   GUARD_RESET=1      reset password if user exists
 */
require('dotenv').config();

import { Op } from 'sequelize';
import models from '../models';
import bcrypt from 'bcryptjs';

async function seedGuard() {
  const db = models();

  const tenantName = process.env.SEED_TENANT_NAME || 'Seguridad Bas';
  const email = (process.env.GUARD_EMAIL || 'guardia.demo@cguardpro.com').toLowerCase();
  const password = process.env.GUARD_PASSWORD || 'GuardiaDemo1234@';
  const reset = process.env.GUARD_RESET === '1';

  // 1) Resolve the tenant by name (prefix match).
  const tenant = await db.tenant.findOne({
    where: { name: { [Op.like]: `${tenantName}%` } },
  });
  if (!tenant) {
    const all = await db.tenant.findAll({ attributes: ['id', 'name'], limit: 50 });
    console.error(`❌ No tenant matching "${tenantName}". Available tenants:`);
    all.forEach((t: any) => console.error(`   - ${t.name}  (${t.id})`));
    process.exit(1);
  }
  console.log(`✔ Tenant: ${tenant.name} (${tenant.id})`);

  // 2) User.
  let user = await db.user.findOne({ where: { email } });
  if (user) {
    console.log('• User already exists:', email);
    if (reset) {
      await user.update({ password: bcrypt.hashSync(password, 8), emailVerified: true });
      console.log('• Password reset.');
    }
  } else {
    const userData = {
      email,
      password: bcrypt.hashSync(password, 8),
      fullName: 'Guardia Demo',
      emailVerified: true,
    };
    user = await db.user.create(userData, { fields: Object.keys(userData) });
    console.log('• User created.');
  }

  // 3) Tenant membership with securityGuard role.
  const membership = await db.tenantUser.findOne({
    where: { userId: user.id, tenantId: tenant.id },
  });
  if (membership) {
    const roles: string[] = Array.isArray(membership.roles) ? membership.roles : [];
    if (!roles.includes('securityGuard')) {
      await membership.update({ roles: [...roles, 'securityGuard'], status: 'active' });
      console.log('• Added securityGuard role to existing membership.');
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
    console.log('• Tenant membership created with securityGuard role.');
  }

  // 4) securityGuard record (so /guard/me resolves).
  const existingGuard = await db.securityGuard.findOne({
    where: { guardId: user.id, tenantId: tenant.id },
  });
  if (!existingGuard) {
    const guardData = {
      guardId: user.id,
      tenantId: tenant.id,
      governmentId: `DEMO-${String(user.id).slice(0, 8)}`,
      fullName: 'Guardia Demo',
      gender: 'Masculino',
      bloodType: 'O+',
      birthDate: '1990-01-01',
      maritalStatus: 'Soltero',
      academicInstruction: 'Secundaria',
      isOnDuty: false,
    };
    await db.securityGuard.create(guardData, { fields: Object.keys(guardData) });
    console.log('• securityGuard record created.');
  } else {
    console.log('• securityGuard record already exists.');
  }

  console.log('\n✅ Guard ready. Sign in to the worker app with:');
  console.log('   Email:   ', email);
  console.log('   Password:', password);
  console.log('   Tenant:  ', tenant.name);
  process.exit(0);
}

seedGuard().catch((err: any) => {
  if (err && err.errors) {
    console.error('Validation error:', err.errors.map((e: any) => `${e.path}: ${e.message}`).join('; '));
  } else {
    console.error(err);
  }
  process.exit(1);
});
