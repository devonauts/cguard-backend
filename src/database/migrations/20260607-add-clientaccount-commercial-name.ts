/**
 * Promote clientAccounts.commercialName from a virtual alias of `name` to a
 * REAL column (the canonical business / "nombre comercial"). It is used as the
 * label of the client's sitio de servicio.
 *
 * Backfill: existing clients get commercialName = full name (name + lastName)
 * so the business name (and any already-created sitio) stays consistent.
 *
 * Run: npx ts-node src/database/migrations/20260607-add-clientaccount-commercial-name.ts
 * Also picked up by run-migrations.ts (npm run migrate:all).
 */
require('dotenv').config();

import { DataTypes, QueryInterface } from 'sequelize';
import models from '../models';

async function migrate() {
  const { sequelize } = models();
  const queryInterface: QueryInterface = sequelize.getQueryInterface();

  try {
    console.log('Starting migration: add clientAccounts.commercialName...');

    const [[tableExists]]: any = await sequelize.query(
      `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'clientAccounts' AND TABLE_SCHEMA = DATABASE()`,
    );
    if (!tableExists) {
      console.log('Table clientAccounts does not exist. Abort.');
      process.exit(0);
    }

    const [existing]: any = await sequelize.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'clientAccounts' AND COLUMN_NAME = 'commercialName' AND TABLE_SCHEMA = DATABASE()`,
    );
    if ((existing as any[]).length === 0) {
      console.log('Adding column: commercialName');
      await queryInterface.addColumn('clientAccounts', 'commercialName', {
        type: DataTypes.STRING(255),
        allowNull: true,
      });
      // Backfill from the full client name so existing data stays consistent.
      await sequelize.query(
        `UPDATE clientAccounts SET commercialName = NULLIF(TRIM(CONCAT_WS(' ', name, lastName)), '') WHERE commercialName IS NULL`,
      );
      console.log('✓ commercialName added + backfilled from name+lastName');
    } else {
      console.log('Column commercialName already exists, skipping.');
    }

    console.log('✅ Migration completed successfully.');
    process.exit(0);
  } catch (error) {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  }
}

migrate();
