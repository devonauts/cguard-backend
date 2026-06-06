/**
 * Make tenants.address / phone / taxNumber NULLABLE so a self-signup tenant can
 * be created "incomplete" and completed via the first-login onboarding wizard.
 * (The wizard enforces these fields at the UX layer instead of the DB layer.)
 *
 * Run: npx ts-node src/database/migrations/20260606-tenant-business-fields-nullable.ts
 * Also picked up automatically by run-migrations.ts (npm run migrate:all).
 */
require('dotenv').config();

import { DataTypes, QueryInterface } from 'sequelize';
import models from '../models';

async function migrate() {
  const { sequelize } = models();
  const queryInterface: QueryInterface = sequelize.getQueryInterface();

  try {
    console.log('Starting migration: make tenants address/phone/taxNumber nullable...');

    const [[tableExists]]: any = await sequelize.query(
      `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'tenants' AND TABLE_SCHEMA = DATABASE()`,
    );
    if (!tableExists) {
      console.log('Table tenants does not exist. Abort.');
      process.exit(0);
    }

    await queryInterface.changeColumn('tenants', 'address', {
      type: DataTypes.TEXT,
      allowNull: true,
      defaultValue: null,
    });
    console.log('✓ address -> NULL');

    await queryInterface.changeColumn('tenants', 'phone', {
      type: DataTypes.STRING(50),
      allowNull: true,
      defaultValue: null,
    });
    console.log('✓ phone -> NULL');

    await queryInterface.changeColumn('tenants', 'taxNumber', {
      type: DataTypes.STRING(255),
      allowNull: true,
      defaultValue: null,
    });
    console.log('✓ taxNumber -> NULL');

    console.log('✅ Migration completed successfully.');
    process.exit(0);
  } catch (error) {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  }
}

migrate();
