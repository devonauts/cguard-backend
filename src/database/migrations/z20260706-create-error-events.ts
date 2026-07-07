/**
 * error_events (errorEvents) — persistence for captured backend errors/crashes,
 * behind the superadmin "Errores" page. Idempotent.
 * Run: npx ts-node src/database/migrations/z20260706-create-error-events.ts
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
    .includes('errorEvents');
  if (has) {
    console.log('errorEvents already exists, skipping');
    process.exit(0);
    return;
  }

  await qi.createTable('errorEvents', {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    fingerprint: { type: DataTypes.STRING(64), allowNull: false },
    name: { type: DataTypes.STRING(128), allowNull: true },
    message: { type: DataTypes.TEXT, allowNull: true },
    stack: { type: DataTypes.TEXT, allowNull: true },
    statusCode: { type: DataTypes.INTEGER, allowNull: true, defaultValue: 500 },
    method: { type: DataTypes.STRING(8), allowNull: true },
    route: { type: DataTypes.STRING(255), allowNull: true },
    source: { type: DataTypes.STRING(24), allowNull: false, defaultValue: 'request' },
    tenantId: { type: DataTypes.UUID, allowNull: true },
    userId: { type: DataTypes.UUID, allowNull: true },
    ip: { type: DataTypes.STRING(64), allowNull: true },
    userAgent: { type: DataTypes.STRING(255), allowNull: true },
    requestId: { type: DataTypes.STRING(32), allowNull: true },
    pmInstance: { type: DataTypes.STRING(8), allowNull: true },
    resolved: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    resolvedAt: { type: DataTypes.DATE, allowNull: true },
    createdAt: { type: DataTypes.DATE, allowNull: false },
    updatedAt: { type: DataTypes.DATE, allowNull: false },
  });
  await qi.addIndex('errorEvents', ['fingerprint']);
  await qi.addIndex('errorEvents', ['createdAt']);
  await qi.addIndex('errorEvents', ['tenantId']);
  await qi.addIndex('errorEvents', ['resolved']);
  await qi.addIndex('errorEvents', ['statusCode']);

  console.log('Created errorEvents');
  process.exit(0);
}

migrate().catch((e) => {
  console.error(e);
  process.exit(1);
});
