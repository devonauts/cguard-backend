require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

/**
 * Shift reminders — add shifts.remindersSent (JSON array of offset keys already
 * pushed, e.g. ["2d","1d","12h"]). Used by runShiftReminders to dedupe across
 * the PM2 cluster via an atomic JSON_ARRAY_APPEND claim. Idempotent.
 */
async function migrate() {
  const { sequelize } = models();
  const qi: QueryInterface = sequelize.getQueryInterface();

  try {
    const table = await qi.describeTable('shifts');
    if (!table.remindersSent) {
      console.log('Adding shifts.remindersSent...');
      await qi.addColumn('shifts', 'remindersSent', {
        type: DataTypes.JSON,
        allowNull: true,
        defaultValue: null,
      });
      console.log('✅ shifts.remindersSent added');
    } else {
      console.log('shifts.remindersSent exists, skipping');
    }
    process.exit(0);
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  }
}

export { migrate };

migrate();
