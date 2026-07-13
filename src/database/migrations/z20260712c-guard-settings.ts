/**
 * Configuración Global de Vigilantes (Configuración › keep-safe): adds
 * settings.guardSettings (JSON text; defaults merged in guardSettingsService)
 * and guardShifts.inactivityAlertAt (one guard.inactive alert per silence
 * episode — guardInactivityService).
 * Idempotent. Run: npx ts-node src/database/migrations/z20260712c-guard-settings.ts
 */
require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

async function migrate() {
  const { sequelize } = models();
  const qi: QueryInterface = sequelize.getQueryInterface();

  const settings: any = await qi.describeTable('settings');
  if (!settings.guardSettings) {
    await qi.addColumn('settings', 'guardSettings', {
      type: DataTypes.TEXT,
      allowNull: true,
    });
    console.log('✅ settings.guardSettings added');
  } else {
    console.log('↷ settings.guardSettings already exists');
  }

  const gs: any = await qi.describeTable('guardShifts');
  if (!gs.inactivityAlertAt) {
    await qi.addColumn('guardShifts', 'inactivityAlertAt', {
      type: DataTypes.DATE,
      allowNull: true,
    });
    console.log('✅ guardShifts.inactivityAlertAt added');
  } else {
    console.log('↷ guardShifts.inactivityAlertAt already exists');
  }
}

migrate()
  .then(() => { console.log('done'); process.exit(0); })
  .catch((e) => { console.error(e); process.exit(1); });
