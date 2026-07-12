require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

/**
 * locationPings — append-only GPS breadcrumb trail.
 *
 * The live endpoints only overwrite one last-known position; this records every
 * ping so the CRM can draw the actual route walked (polyline) and audit a shift.
 * Indexed for (tenant, guard|user, time-range) trail reads.
 *
 * Idempotent. Run: npx ts-node src/database/migrations/z20260712b-create-location-pings.ts
 */

const TABLE = 'locationPings';

async function migrate() {
  const { sequelize } = models();
  const qi: QueryInterface = sequelize.getQueryInterface();

  const tables = await qi.showAllTables();
  const has = (tables as any[])
    .map((t: any) => (typeof t === 'string' ? t : t.tableName))
    .includes(TABLE);

  if (has) {
    console.log(`↷ Table ${TABLE} already exists. Skipping.`);
    return;
  }

  await qi.createTable(TABLE, {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    tenantId: { type: DataTypes.UUID, allowNull: false },
    subjectType: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'guard' },
    userId: { type: DataTypes.UUID, allowNull: true },
    securityGuardId: { type: DataTypes.UUID, allowNull: true },
    guardShiftId: { type: DataTypes.UUID, allowNull: true },
    latitude: { type: DataTypes.DOUBLE, allowNull: false },
    longitude: { type: DataTypes.DOUBLE, allowNull: false },
    accuracy: { type: DataTypes.FLOAT, allowNull: true },
    speed: { type: DataTypes.FLOAT, allowNull: true },
    heading: { type: DataTypes.FLOAT, allowNull: true },
    battery: { type: DataTypes.INTEGER, allowNull: true },
    recordedAt: { type: DataTypes.DATE, allowNull: false },
    createdAt: { type: DataTypes.DATE, allowNull: false },
  });

  await qi.addIndex(TABLE, ['tenantId', 'securityGuardId', 'recordedAt'], {
    name: 'idx_locationPings_tenant_guard_time',
  });
  await qi.addIndex(TABLE, ['tenantId', 'userId', 'recordedAt'], {
    name: 'idx_locationPings_tenant_user_time',
  });
  await qi.addIndex(TABLE, ['guardShiftId'], { name: 'idx_locationPings_shift' });

  console.log(`✅ Created table ${TABLE}`);
}

migrate()
  .then(() => { console.log('done'); process.exit(0); })
  .catch((e) => { console.error('Migration failed:', e); process.exit(1); });
