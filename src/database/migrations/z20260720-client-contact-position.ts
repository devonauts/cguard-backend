require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

/**
 * Add `position` (contact role / "cargo") to `clientContacts`. The client-contact
 * form and its OpenAPI advertise a position field, but there was no column, so a
 * contact's role was silently dropped on every save. Idempotent.
 * Run: npx ts-node src/database/migrations/z20260720-client-contact-position.ts
 */
async function migrate() {
  const { sequelize } = models();
  const qi: QueryInterface = sequelize.getQueryInterface();
  try {
    const [rows]: any = await sequelize.query(
      `SELECT COUNT(*) as c FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'clientContacts' AND COLUMN_NAME = 'position'`,
    );
    if (rows && rows[0] && Number(rows[0].c) > 0) {
      console.log('clientContacts.position already exists, skipping.');
    } else {
      await qi.addColumn('clientContacts', 'position', { type: DataTypes.STRING(150), allowNull: true });
      console.log('✅ clientContacts.position added');
    }
    process.exit(0);
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  }
}

migrate();
