require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

/**
 * Adds the shift-summary snapshot columns to `guardShifts`:
 *   checkpointsScanned, incidentsLogged, distanceMeters
 * Populated at clock-out by computeShiftMetrics(); read by the guard
 * "last shift" card. Nullable (no default) so a row that predates this
 * migration stays NULL and the endpoint recomputes it live.
 */
async function migrate() {
  const { sequelize } = models();
  const queryInterface: QueryInterface = sequelize.getQueryInterface();

  try {
    const table: any = await queryInterface.describeTable('guardShifts');

    const addIfMissing = async (name: string) => {
      if (table[name]) {
        console.log(`Column ${name} already exists on guardShifts, skipping`);
        return;
      }
      console.log(`Adding column ${name} to guardShifts...`);
      await queryInterface.addColumn('guardShifts', name, {
        type: DataTypes.INTEGER,
        allowNull: true,
      });
    };

    await addIfMissing('checkpointsScanned');
    await addIfMissing('incidentsLogged');
    await addIfMissing('distanceMeters');

    console.log('✅ guardShifts shift-metrics columns ready');
    process.exit(0);
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  }
}

export { migrate };

migrate();
