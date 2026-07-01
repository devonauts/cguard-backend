/**
 * Supervisor shift (clock-in / clock-out) for the supervisor mobile app.
 *   - Creates `supervisorShifts` (one open row per supervisor while on the clock).
 * Idempotent.
 * Run: npx ts-node src/database/migrations/z20260701-create-supervisor-shift.ts
 */
require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

async function migrate() {
  const { sequelize } = models();
  const qi: QueryInterface = sequelize.getQueryInterface();
  const tables = (await qi.showAllTables()) as string[];

  const hasTable = tables.some((t) => /^supervisorShifts$/i.test(t));
  if (!hasTable) {
    await qi.createTable('supervisorShifts', {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      tenantId: { type: DataTypes.UUID, allowNull: false },
      supervisorUserId: { type: DataTypes.UUID, allowNull: false },
      punchInTime: { type: DataTypes.DATE, allowNull: false },
      punchInLat: { type: DataTypes.DECIMAL(10, 7), allowNull: true },
      punchInLng: { type: DataTypes.DECIMAL(10, 7), allowNull: true },
      punchOutTime: { type: DataTypes.DATE, allowNull: true },
      punchOutLat: { type: DataTypes.DECIMAL(10, 7), allowNull: true },
      punchOutLng: { type: DataTypes.DECIMAL(10, 7), allowNull: true },
      observations: { type: DataTypes.TEXT, allowNull: true },
      createdAt: { type: DataTypes.DATE, allowNull: false },
      updatedAt: { type: DataTypes.DATE, allowNull: false },
      deletedAt: { type: DataTypes.DATE, allowNull: true },
    });
    console.log('✅ Created table supervisorShifts');
    try {
      await qi.addIndex('supervisorShifts', ['tenantId', 'supervisorUserId', 'punchOutTime'], {
        name: 'supshift_tenant_user_open_idx',
      });
      console.log('✅ Added supervisorShifts index');
    } catch (e: any) {
      console.log('• supervisorShifts index skipped:', e?.message || e);
    }
  } else {
    console.log('• supervisorShifts already exists, skipping');
  }

  process.exit(0);
}

migrate().catch((err) => {
  console.error(err);
  process.exit(1);
});
