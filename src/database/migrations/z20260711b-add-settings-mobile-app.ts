require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

/**
 * Team mobile hub: add settings.mobileAppSettings — a per-tenant JSON blob
 * that customizes the worker & supervisor apps (accent color, display
 * name/tagline, tenant logo toggle, default theme, module visibility).
 * Defaults are merged in code (services/mobileAppSettingsService.ts) so a
 * missing key = default. Read by the apps via GET /tenant/:id/mobile-app-config,
 * written from the CRM Settings › Hub móvil page via the existing settings PUT.
 * Idempotent. Run: npx ts-node src/database/migrations/z20260711b-add-settings-mobile-app.ts
 */
async function migrate() {
  const { sequelize } = models();
  const qi: QueryInterface = sequelize.getQueryInterface();

  const table: any = await qi.describeTable('settings');
  if (!table.mobileAppSettings) {
    await qi.addColumn('settings', 'mobileAppSettings', {
      type: DataTypes.TEXT,
      allowNull: true,
    });
    console.log('✅ settings.mobileAppSettings added');
  } else {
    console.log('↷ settings.mobileAppSettings already exists');
  }
}

migrate()
  .then(() => { console.log('done'); process.exit(0); })
  .catch((e) => { console.error(e); process.exit(1); });
