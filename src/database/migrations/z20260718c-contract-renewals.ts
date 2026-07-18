require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

/**
 * contractRenewals — history of contract periods (actual + previous renewals)
 * shown in the "Historial de renovaciones" table of the client contract subpage.
 *
 * Idempotent. Run: npx ts-node src/database/migrations/z20260718c-contract-renewals.ts
 */
const TABLE = 'contractRenewals';

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
    periodLabel: { type: DataTypes.STRING(60), allowNull: true },
    fromDate: { type: DataTypes.DATEONLY, allowNull: true },
    toDate: { type: DataTypes.DATEONLY, allowNull: true },
    durationMonths: { type: DataTypes.INTEGER, allowNull: true },
    status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'active' },
    createdById: { type: DataTypes.UUID, allowNull: true },
    updatedById: { type: DataTypes.UUID, allowNull: true },
    createdAt: { type: DataTypes.DATE, allowNull: false },
    updatedAt: { type: DataTypes.DATE, allowNull: false },
    deletedAt: { type: DataTypes.DATE, allowNull: true },
  });

  await qi.addIndex(TABLE, ['tenantId', 'clientAccountId'], {
    name: 'idx_contractRenewals_tenant_client',
  });

  console.log(`✅ Created table ${TABLE}`);
  process.exit(0);
}

migrate().catch((e) => { console.error('Migration failed:', e); process.exit(1); });
