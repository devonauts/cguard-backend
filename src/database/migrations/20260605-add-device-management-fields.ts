/**
 * Device management: extend deviceIdInformations so a device is linked to a guard
 * and carries real device identity (model/OS/app version), a separate push token,
 * and the bind/flag state used for anti-buddy-punching.
 *
 *   userId         the guard who owns/uses this device
 *   platform       ios | android | web
 *   model          device model (e.g. "iPhone15,2", "Pixel 7")
 *   manufacturer   device manufacturer
 *   osVersion      OS version
 *   appVersion     app build (marketing version)
 *   pushToken      FCM token (kept separate from the stable deviceId)
 *   isBound        this is the guard's bound/primary device
 *   flagged        seen on a DIFFERENT device than the bound one (mismatch)
 *   lastSeenAt     last time the app reported this device
 *   lastMismatchAt last time a mismatch was recorded for this guard
 *
 * Idempotent.
 * Run: npx ts-node src/database/migrations/20260605-add-device-management-fields.ts
 */
require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

const COLUMNS: Record<string, any> = {
  userId: { type: DataTypes.UUID, allowNull: true },
  platform: { type: DataTypes.STRING(40), allowNull: true },
  model: { type: DataTypes.STRING(120), allowNull: true },
  manufacturer: { type: DataTypes.STRING(120), allowNull: true },
  osVersion: { type: DataTypes.STRING(60), allowNull: true },
  appVersion: { type: DataTypes.STRING(40), allowNull: true },
  pushToken: { type: DataTypes.TEXT, allowNull: true },
  isBound: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  flagged: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  lastSeenAt: { type: DataTypes.DATE, allowNull: true },
  lastMismatchAt: { type: DataTypes.DATE, allowNull: true },
};

async function migrate() {
  const { sequelize } = models();
  const qi: QueryInterface = sequelize.getQueryInterface();
  const tables = await qi.showAllTables();
  const table =
    (tables as string[]).find((t) => /^deviceIdInformations$/i.test(t)) ||
    'deviceIdInformations';
  const desc = await qi.describeTable(table);

  for (const [name, spec] of Object.entries(COLUMNS)) {
    if (desc[name]) {
      console.log(`• ${name} already exists on ${table}, skipping`);
      continue;
    }
    await qi.addColumn(table, name, spec);
    console.log(`✅ Added ${name} to ${table}`);
  }
  process.exit(0);
}

migrate().catch((err) => {
  console.error(err);
  process.exit(1);
});
