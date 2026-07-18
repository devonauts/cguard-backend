require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

/**
 * contractServices — the catalog of services a client contracted (vigilancia
 * fija, patrullaje móvil, monitoreo, control de acceso, etc.) with the CONTRACTED
 * quantity and per-service SLA target. Live "utilizado" is computed from real
 * operations at read time (no amounts stored — product has no invoicing).
 *
 * Idempotent. Run: npx ts-node src/database/migrations/z20260718b-contract-services.ts
 */
const TABLE = 'contractServices';

async function migrate() {
  const { sequelize } = models();
  const qi: QueryInterface = sequelize.getQueryInterface();

  const tables = await qi.showAllTables();
  const has = (tables as any[])
    .map((t: any) => (typeof t === 'string' ? t : t.tableName))
    .includes(TABLE);

  if (has) {
    console.log(`↷ Table ${TABLE} already exists. Skipping.`);
    process.exit(0);
    return;
  }

  await qi.createTable(TABLE, {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    tenantId: { type: DataTypes.UUID, allowNull: false },
    clientAccountId: { type: DataTypes.UUID, allowNull: false },
    // Known key drives live-usage computation; 'custom' = free-form service.
    serviceKey: { type: DataTypes.STRING(40), allowNull: false, defaultValue: 'custom' },
    name: { type: DataTypes.STRING(120), allowNull: false },
    description: { type: DataTypes.STRING(255), allowNull: true },
    unit: { type: DataTypes.STRING(40), allowNull: true },
    // null contractedQty = "ilimitado"
    contractedQty: { type: DataTypes.INTEGER, allowNull: true },
    slaTarget: { type: DataTypes.INTEGER, allowNull: true },
    sortOrder: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    createdById: { type: DataTypes.UUID, allowNull: true },
    updatedById: { type: DataTypes.UUID, allowNull: true },
    createdAt: { type: DataTypes.DATE, allowNull: false },
    updatedAt: { type: DataTypes.DATE, allowNull: false },
    deletedAt: { type: DataTypes.DATE, allowNull: true },
  });

  await qi.addIndex(TABLE, ['tenantId', 'clientAccountId'], {
    name: 'idx_contractServices_tenant_client',
  });

  console.log(`✅ Created table ${TABLE}`);
  process.exit(0);
}

migrate().catch((e) => { console.error('Migration failed:', e); process.exit(1); });
