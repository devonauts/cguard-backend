require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

async function migrate() {
  const { sequelize } = models();
  const queryInterface: QueryInterface = sequelize.getQueryInterface();

  try {
    console.log('Adding availability column to securityGuards...');

    // Ensure we don't fail if column already exists
    const tableDesc = await queryInterface.describeTable('securityGuards');
    if (tableDesc && tableDesc.availability) {
      console.log('Column availability already exists on securityGuards — skipping.');
      process.exit(0);
    }

    // Choose JSONB for Postgres, JSON for others
    const dialect = (sequelize.getDialect && sequelize.getDialect()) || process.env.DATABASE_DIALECT || 'mysql';
    const isPostgres = String(dialect).toLowerCase().includes('postgres');

    await queryInterface.addColumn('securityGuards', 'availability', {
      type: isPostgres ? (DataTypes as any).JSONB || DataTypes.JSON : DataTypes.JSON,
      allowNull: true,
    });

    console.log('✅ securityGuards.availability column added');
    process.exit(0);
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  }
}

migrate();
