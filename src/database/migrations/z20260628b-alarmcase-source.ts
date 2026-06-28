require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

/**
 * Add alarmCases.source — the ORIGIN of an alarm case so operators can tell at a
 * glance where it came from: 'alarm_panel' (hardware monitoring signal),
 * 'client_app' (Mi Seguridad customer SOS), 'worker_app' (guard panic button),
 * 'manual' (operator-created). Backfills existing rows: a panel-linked case is
 * alarm_panel, a customer-linked case is client_app, everything else (legacy) is
 * alarm_panel (the alarm module was panel-only before this). Idempotent.
 */
async function migrate() {
  const { sequelize } = models();
  const queryInterface: QueryInterface = sequelize.getQueryInterface();

  try {
    const table = await queryInterface.describeTable('alarmCases');
    if (!table.source) {
      console.log('Adding alarmCases.source…');
      await queryInterface.addColumn('alarmCases', 'source', {
        type: DataTypes.STRING(16),
        allowNull: true,
      });
      await sequelize.query(
        `UPDATE alarmCases
            SET source = CASE
              WHEN alarmPanelId IS NOT NULL THEN 'alarm_panel'
              WHEN customerId   IS NOT NULL THEN 'client_app'
              ELSE 'alarm_panel'
            END
          WHERE source IS NULL`,
      );
      console.log('✅ alarmCases.source added + backfilled');
    } else {
      console.log('alarmCases.source already exists, skipping');
    }

    process.exit(0);
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  }
}

export { migrate };

migrate();
