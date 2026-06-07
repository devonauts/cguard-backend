require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

/**
 * Phase 4 (real proximity): geocoded home coordinates for guards. Populated by
 * geocoding the address on save (and a backfill endpoint); used to rank guards
 * by real haversine distance to a station instead of the old keyword guess.
 */
async function migrate() {
  const { sequelize } = models();
  const qi: QueryInterface = sequelize.getQueryInterface();

  try {
    const table: any = await qi.describeTable('securityGuards');
    const addIfMissing = async (name: string) => {
      if (table[name]) { console.log(`Column ${name} already exists, skipping`); return; }
      console.log(`Adding column ${name} to securityGuards...`);
      await qi.addColumn('securityGuards', name, { type: DataTypes.DOUBLE, allowNull: true });
    };
    await addIfMissing('latitude');
    await addIfMissing('longitude');
    console.log('✅ securityGuards latitude/longitude ready');
    process.exit(0);
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  }
}

export { migrate };

migrate();
