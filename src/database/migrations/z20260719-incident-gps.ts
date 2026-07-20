require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

/**
 * Add latitude/longitude to `incidents` — the worker app always sent the
 * guard's GPS fix on incident creation but the backend had nowhere to store
 * it, so neither the CRM nor the client could see where an incident happened.
 * Idempotent. Run: npx ts-node src/database/migrations/z20260719-incident-gps.ts
 */
async function migrate() {
  const { sequelize } = models();
  const qi: QueryInterface = sequelize.getQueryInterface();
  try {
    for (const col of ['latitude', 'longitude']) {
      const [rows]: any = await sequelize.query(
        `SELECT COUNT(*) as c FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'incidents' AND COLUMN_NAME = '${col}'`,
      );
      if (rows && rows[0] && Number(rows[0].c) > 0) {
        console.log(`incidents.${col} already exists, skipping.`);
      } else {
        await qi.addColumn('incidents', col, { type: DataTypes.DECIMAL(10, 7), allowNull: true });
        console.log(`✅ incidents.${col} added`);
      }
    }
    process.exit(0);
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  }
}

migrate();
