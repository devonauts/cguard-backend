/**
 * Reglas globales de puestos (Configuración › Configuración Global de Puestos):
 * adds settings.postRules (JSON text, defaults merged in postRulesService) and
 * the guardShift geofence-alert state columns (liveGeofenceOutside/-Streak)
 * used by the exit/return detection on location pings.
 * Idempotent. Run: npx ts-node src/database/migrations/z20260712b-post-rules.ts
 */
require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

async function migrate() {
  const { sequelize } = models();
  const qi: QueryInterface = sequelize.getQueryInterface();

  const settings: any = await qi.describeTable('settings');
  if (!settings.postRules) {
    await qi.addColumn('settings', 'postRules', {
      type: DataTypes.TEXT,
      allowNull: true,
    });
    console.log('✅ settings.postRules added');
  } else {
    console.log('↷ settings.postRules already exists');
  }

  const gs: any = await qi.describeTable('guardShifts');
  if (!gs.liveGeofenceOutside) {
    await qi.addColumn('guardShifts', 'liveGeofenceOutside', {
      type: DataTypes.BOOLEAN,
      allowNull: true,
    });
    console.log('✅ guardShifts.liveGeofenceOutside added');
  } else {
    console.log('↷ guardShifts.liveGeofenceOutside already exists');
  }
  if (!gs.liveGeofenceStreak) {
    await qi.addColumn('guardShifts', 'liveGeofenceStreak', {
      type: DataTypes.INTEGER,
      allowNull: true,
    });
    console.log('✅ guardShifts.liveGeofenceStreak added');
  } else {
    console.log('↷ guardShifts.liveGeofenceStreak already exists');
  }
}

migrate()
  .then(() => { console.log('done'); process.exit(0); })
  .catch((e) => { console.error(e); process.exit(1); });
