/**
 * Create the superAdminAuditLogs table — append-only audit trail for actions
 * taken through the platform superadmin panel.
 * Idempotent: skips if the table already exists.
 *
 * Run: npx ts-node src/database/migrations/20260606-create-superadmin-audit-logs.ts
 */
require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

async function migrate() {
  const { sequelize } = models();
  const qi: QueryInterface = sequelize.getQueryInterface();

  const tables = await qi.showAllTables();
  const exists = (tables as string[]).some((t) => /^superadminauditlogs$/i.test(t));
  if (exists) {
    console.log('Table superAdminAuditLogs already exists, skipping');
    process.exit(0);
  }

  await qi.createTable('superAdminAuditLogs', {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
    actorUserId: { type: DataTypes.UUID, allowNull: true },
    actorEmail: { type: DataTypes.STRING(255), allowNull: true },
    action: { type: DataTypes.STRING(100), allowNull: false },
    targetType: { type: DataTypes.STRING(60), allowNull: true },
    targetId: { type: DataTypes.STRING(64), allowNull: true },
    tenantId: { type: DataTypes.UUID, allowNull: true },
    method: { type: DataTypes.STRING(10), allowNull: true },
    path: { type: DataTypes.STRING(512), allowNull: true },
    ip: { type: DataTypes.STRING(64), allowNull: true },
    statusCode: { type: DataTypes.INTEGER, allowNull: true },
    details: { type: DataTypes.JSON, allowNull: true },
    createdAt: { type: DataTypes.DATE, allowNull: false },
    updatedAt: { type: DataTypes.DATE, allowNull: false },
  });

  await qi.addIndex('superAdminAuditLogs', ['actorUserId']);
  await qi.addIndex('superAdminAuditLogs', ['tenantId']);
  await qi.addIndex('superAdminAuditLogs', ['action']);
  await qi.addIndex('superAdminAuditLogs', ['createdAt']);

  console.log('Created table superAdminAuditLogs');
  process.exit(0);
}

migrate().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
