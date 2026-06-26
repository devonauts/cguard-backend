require('dotenv').config();

import models from '../models';
import { DataTypes } from 'sequelize';

/**
 * Add visitorLogs.archived so the CRM "archivar" action actually hides a visit.
 * Previously there was no column — the update silently dropped it and the toast
 * lied. Nullable boolean default false; existing rows read as not-archived.
 */
async function migrate() {
  const { sequelize } = models();
  const qi = sequelize.getQueryInterface();
  try {
    const [rows]: any = await sequelize.query(
      `SELECT 1 FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'visitorLogs' AND column_name = 'archived' LIMIT 1`,
    );
    if (rows && rows.length) {
      console.log('↩︎  visitorLogs.archived already exists');
      process.exit(0);
    }
    await qi.addColumn('visitorLogs', 'archived', {
      type: DataTypes.BOOLEAN,
      allowNull: true,
      defaultValue: false,
    });
    console.log('✅ visitorLogs.archived added');
    process.exit(0);
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  }
}

export { migrate };

migrate();
