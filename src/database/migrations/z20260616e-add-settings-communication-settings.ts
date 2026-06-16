require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

/**
 * Foundation (unified communications): add settings.communicationSettings — a
 * per-tenant JSON blob holding channel toggles, OTP preference, wallet rules and
 * per-event toggles. Defaults are merged in code
 * (services/communication/communicationSettingsService.ts). Idempotent.
 *
 * The per-tenant settings table is 'settings' (PK = tenantId). Confirmed via
 * describeTable below before adding the column.
 */
async function migrate() {
  const { sequelize } = models();
  const qi: QueryInterface = sequelize.getQueryInterface();

  try {
    let table: any;
    try {
      table = await qi.describeTable('settings');
    } catch (e) {
      console.error('Could not describe settings table — aborting.', e);
      process.exit(1);
    }

    if (!table.communicationSettings) {
      console.log('Adding settings.communicationSettings...');
      await qi.addColumn('settings', 'communicationSettings', {
        type: DataTypes.TEXT,
        allowNull: true,
        defaultValue: null,
      });
      console.log('✅ settings.communicationSettings added.');
    } else {
      console.log('settings.communicationSettings exists, skipping.');
    }

    process.exit(0);
  } catch (error) {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  }
}

export { migrate };

migrate();
