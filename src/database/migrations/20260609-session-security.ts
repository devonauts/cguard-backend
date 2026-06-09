/**
 * Session security: an audit log of every auth/session/device event.
 * (Single-session reuses the existing users.jwtTokenInvalidBefore; the device
 * registry reuses deviceIdInformation — only this audit table is new.)
 * Idempotent. Run: npx ts-node src/database/migrations/20260609-session-security.ts
 */
require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

async function migrate() {
  const { sequelize } = models();
  const qi: QueryInterface = sequelize.getQueryInterface();
  const tables = await qi.showAllTables();
  const has = (t: string) => (tables as any[]).map((x) => String(x).toLowerCase()).includes(t.toLowerCase());

  if (!has('securityAuditLogs')) {
    await qi.createTable('securityAuditLogs', {
      id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
      tenantId: { type: DataTypes.UUID, allowNull: true },
      userId: { type: DataTypes.UUID, allowNull: true },
      email: { type: DataTypes.STRING(255), allowNull: true },
      // login | login_failed | logout | session_superseded | device_registered |
      // device_evicted | token_rejected | password_reset | ...
      event: { type: DataTypes.STRING(40), allowNull: false },
      outcome: { type: DataTypes.STRING(20), allowNull: true }, // success | failure
      ip: { type: DataTypes.STRING(60), allowNull: true },
      userAgent: { type: DataTypes.STRING(400), allowNull: true },
      deviceId: { type: DataTypes.STRING(200), allowNull: true },
      platform: { type: DataTypes.STRING(40), allowNull: true },
      detail: { type: DataTypes.TEXT, allowNull: true },
      at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
      createdAt: { type: DataTypes.DATE, allowNull: false },
      updatedAt: { type: DataTypes.DATE, allowNull: false },
      deletedAt: { type: DataTypes.DATE, allowNull: true },
    });
    await qi.addIndex('securityAuditLogs', ['tenantId', 'userId', 'at']);
    await qi.addIndex('securityAuditLogs', ['event']);
    console.log('Created securityAuditLogs');
  } else {
    console.log('securityAuditLogs exists, skipping');
  }
  console.log('session-security migration complete');
  process.exit(0);
}

migrate().catch((err) => { console.error('Migration failed:', err); process.exit(1); });
