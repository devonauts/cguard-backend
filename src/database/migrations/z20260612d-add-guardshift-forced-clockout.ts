require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

/**
 * Forced clock-out at shift end — add guardShifts.forcedClockOut (BOOLEAN).
 * Set by the scheduler when a guard's shift ends without them clocking out in
 * the app (no end-of-shift novedades). Idempotent.
 */
async function migrate() {
  const { sequelize } = models();
  const qi: QueryInterface = sequelize.getQueryInterface();

  try {
    const table = await qi.describeTable('guardShifts');
    if (!table.forcedClockOut) {
      console.log('Adding guardShifts.forcedClockOut...');
      await qi.addColumn('guardShifts', 'forcedClockOut', {
        type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false,
      });
      console.log('✅ guardShifts.forcedClockOut added');
    } else { console.log('guardShifts.forcedClockOut exists, skipping'); }
    process.exit(0);
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  }
}

export { migrate };

migrate();
