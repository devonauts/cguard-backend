/**
 * metricsSnapshots — per-minute observability time series. Idempotent.
 * Run: npx ts-node src/database/migrations/z20260706b-create-metrics-snapshot.ts
 */
require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

async function migrate() {
  const { sequelize } = models();
  const qi: QueryInterface = sequelize.getQueryInterface();

  const tables = await qi.showAllTables();
  const has = (tables as any[])
    .map((t: any) => (typeof t === 'string' ? t : t.tableName))
    .includes('metricsSnapshots');
  if (has) {
    console.log('metricsSnapshots already exists, skipping');
    process.exit(0);
    return;
  }

  await qi.createTable('metricsSnapshots', {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    hostMemPct: { type: DataTypes.FLOAT, allowNull: true },
    heapUsedPct: { type: DataTypes.FLOAT, allowNull: true },
    rss: { type: DataTypes.BIGINT, allowNull: true },
    loadPct: { type: DataTypes.FLOAT, allowNull: true },
    diskPct: { type: DataTypes.FLOAT, allowNull: true },
    dbPoolUsing: { type: DataTypes.INTEGER, allowNull: true },
    dbPoolWaiting: { type: DataTypes.INTEGER, allowNull: true },
    dbPoolMax: { type: DataTypes.INTEGER, allowNull: true },
    dbSizeBytes: { type: DataTypes.BIGINT, allowNull: true },
    slowTotal: { type: DataTypes.INTEGER, allowNull: true },
    slowMax: { type: DataTypes.INTEGER, allowNull: true },
    errorCount: { type: DataTypes.INTEGER, allowNull: true },
    jobErrors: { type: DataTypes.INTEGER, allowNull: true },
    extra: { type: DataTypes.JSON, allowNull: true },
    createdAt: { type: DataTypes.DATE, allowNull: false },
    updatedAt: { type: DataTypes.DATE, allowNull: false },
  });
  await qi.addIndex('metricsSnapshots', ['createdAt']);

  console.log('Created metricsSnapshots');
  process.exit(0);
}

migrate().catch((e) => {
  console.error(e);
  process.exit(1);
});
