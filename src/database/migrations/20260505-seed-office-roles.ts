/**
 * Migration: Seed administrative office roles for all existing tenants.
 * Creates administrativeSupervisor, administrativeAssistant, secretary
 * with sensible default permissions that tenants can further customize.
 */
require('dotenv').config();

import models from '../models';

const ADMIN_SUPERVISOR_PERMISSIONS = [
  'userRead', 'userCreate', 'userEdit', 'userAutocomplete',
  'clientAccountRead', 'clientAccountCreate', 'clientAccountEdit', 'clientAccountAutocomplete',
  'securityGuardRead', 'securityGuardEdit', 'securityGuardAutocomplete',
  'businessInfoRead', 'businessInfoCreate', 'businessInfoEdit', 'businessInfoAutocomplete',
  'stationRead', 'stationCreate', 'stationEdit', 'stationAutocomplete',
  'incidentRead', 'incidentCreate', 'incidentEdit', 'incidentAutocomplete',
  'shiftRead', 'shiftCreate', 'shiftEdit', 'shiftAutocomplete',
  'guardShiftRead', 'guardShiftCreate', 'guardShiftEdit', 'guardShiftAutocomplete',
  'patrolRead', 'patrolAutocomplete',
  'patrolLogRead', 'patrolLogAutocomplete',
  'reportRead', 'reportCreate', 'reportAutocomplete',
  'inventoryRead', 'inventoryCreate', 'inventoryEdit', 'inventoryAutocomplete',
  'visitorLogRead', 'visitorLogCreate', 'visitorLogEdit', 'visitorLogAutocomplete',
  'dispatchRead', 'dispatchCreate', 'dispatchEdit', 'dispatchAutocomplete',
  'taskRead', 'taskCreate', 'taskEdit', 'taskAutocomplete',
  'memosRead', 'memosCreate', 'memosAutocomplete',
  'categoryRead', 'categoryCreate', 'categoryAutocomplete',
  'serviceRead', 'serviceAutocomplete',
  'notificationRead', 'notificationAutocomplete',
  'settingsRead',
  'certificationRead', 'certificationAutocomplete',
  'licenseTypeRead', 'licenseTypeAutocomplete',
  'fileRead', 'fileCreate',
];

const ADMIN_ASSISTANT_PERMISSIONS = [
  'userRead', 'userAutocomplete',
  'clientAccountRead', 'clientAccountAutocomplete',
  'securityGuardRead', 'securityGuardAutocomplete',
  'businessInfoRead', 'businessInfoAutocomplete',
  'stationRead', 'stationAutocomplete',
  'incidentRead', 'incidentCreate', 'incidentAutocomplete',
  'shiftRead', 'shiftAutocomplete',
  'guardShiftRead', 'guardShiftAutocomplete',
  'patrolRead', 'patrolAutocomplete',
  'reportRead', 'reportAutocomplete',
  'inventoryRead', 'inventoryAutocomplete',
  'visitorLogRead', 'visitorLogCreate', 'visitorLogAutocomplete',
  'dispatchRead', 'dispatchAutocomplete',
  'taskRead', 'taskCreate', 'taskAutocomplete',
  'memosRead', 'memosAutocomplete',
  'categoryRead', 'categoryAutocomplete',
  'serviceRead', 'serviceAutocomplete',
  'notificationRead', 'notificationAutocomplete',
  'settingsRead',
  'certificationRead', 'certificationAutocomplete',
  'fileRead', 'fileCreate',
];

const SECRETARY_PERMISSIONS = [
  'userRead', 'userAutocomplete',
  'clientAccountRead', 'clientAccountAutocomplete',
  'securityGuardRead', 'securityGuardAutocomplete',
  'businessInfoRead', 'businessInfoAutocomplete',
  'stationRead', 'stationAutocomplete',
  'visitorLogRead', 'visitorLogCreate', 'visitorLogEdit', 'visitorLogAutocomplete',
  'dispatchRead', 'dispatchAutocomplete',
  'taskRead', 'taskCreate', 'taskAutocomplete',
  'memosRead', 'memosAutocomplete',
  'categoryRead', 'categoryAutocomplete',
  'serviceRead', 'serviceAutocomplete',
  'notificationRead', 'notificationAutocomplete',
  'shiftRead', 'shiftAutocomplete',
  'reportRead', 'reportAutocomplete',
  'settingsRead',
  'fileRead',
];

const OFFICE_ROLES = [
  {
    slug: 'administrativeSupervisor',
    name: 'Supervisor Administrativo',
    description: 'Supervisa al personal administrativo y las operaciones de oficina',
    permissions: ADMIN_SUPERVISOR_PERMISSIONS,
  },
  {
    slug: 'administrativeAssistant',
    name: 'Asistente Administrativo',
    description: 'Soporte de oficina y acceso administrativo básico',
    permissions: ADMIN_ASSISTANT_PERMISSIONS,
  },
  {
    slug: 'secretary',
    name: 'Secretaria / Recepcionista',
    description: 'Recepción, gestión de visitantes y coordinación de oficina',
    permissions: SECRETARY_PERMISSIONS,
  },
];

async function migrate() {
  const { sequelize, ...db } = models() as any;

  const transaction = await sequelize.transaction();

  try {
    const tenants = await db.tenant.findAll({ transaction });

    const adminUser = await db.user.findOne({ transaction }).catch(() => null);
    const adminUserId = adminUser ? adminUser.id : null;

    for (const tenant of tenants) {
      for (const roleDef of OFFICE_ROLES) {
        const existing = await db.role.findOne({
          where: { slug: roleDef.slug, tenantId: tenant.id, deletedAt: null },
          transaction,
        }).catch(() => null);

        if (!existing) {
          await db.role.create(
            {
              name: roleDef.name,
              slug: roleDef.slug,
              description: roleDef.description,
              permissions: roleDef.permissions,
              tenantId: tenant.id,
              createdById: adminUserId,
              updatedById: adminUserId,
            },
            { transaction },
          );
          console.log(`✅ Created role '${roleDef.slug}' for tenant ${tenant.id}`);
        } else {
          console.log(`⏭  Role '${roleDef.slug}' already exists for tenant ${tenant.id}`);
        }
      }
    }

    await transaction.commit();
    console.log('✅ Migration 20260505-seed-office-roles complete');
    process.exit(0);
  } catch (err) {
    await transaction.rollback();
    console.error('Migration failed:', err);
    process.exit(1);
  }
}

migrate();
