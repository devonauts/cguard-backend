/**
 * Station inspection (supervisor "Start Inspection" flow): a pass/issues check
 * with notes, a transcribed voice note, and photo/video evidence (files are
 * polymorphic, so no media columns here). Idempotent.
 * Run: npx ts-node src/database/migrations/z20260703b-create-station-inspection.ts
 */
require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

async function migrate() {
  const { sequelize } = models();
  const qi: QueryInterface = sequelize.getQueryInterface();
  const tables = (await qi.showAllTables()) as string[];

  const hasTable = tables.some((t) => /^stationInspections$/i.test(t));
  if (!hasTable) {
    await qi.createTable('stationInspections', {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      tenantId: { type: DataTypes.UUID, allowNull: false },
      stationId: { type: DataTypes.UUID, allowNull: false },
      supervisorUserId: { type: DataTypes.UUID, allowNull: false },
      result: { type: DataTypes.STRING(12), allowNull: false, defaultValue: 'ok' },
      notes: { type: DataTypes.TEXT, allowNull: true },
      transcription: { type: DataTypes.TEXT, allowNull: true },
      latitude: { type: DataTypes.DOUBLE, allowNull: true },
      longitude: { type: DataTypes.DOUBLE, allowNull: true },
      createdAt: { type: DataTypes.DATE, allowNull: false },
      updatedAt: { type: DataTypes.DATE, allowNull: false },
      deletedAt: { type: DataTypes.DATE, allowNull: true },
    });
    console.log('✅ Created table stationInspections');
    try {
      await qi.addIndex('stationInspections', ['tenantId', 'stationId', 'createdAt'], {
        name: 'stninsp_tenant_station_created_idx',
      });
      console.log('✅ Added stationInspections index');
    } catch (e: any) {
      console.log('• stationInspections index skipped:', e?.message || e);
    }
  } else {
    console.log('• stationInspections already exists, skipping');
  }

  process.exit(0);
}

migrate().catch((err) => {
  console.error(err);
  process.exit(1);
});
