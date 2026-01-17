require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

async function migrate() {
  const { sequelize } = models();
  const queryInterface: QueryInterface = sequelize.getQueryInterface();

  try {
    console.log('Starting migration: add invitationTokenExpiresAt to tenant users table...');

    // Try common table name variants used in this project
    const candidates = [
      'tenant_users',
      'tenantUsers',
      'tenantusers',
      'tenant_user',
      'tenantuser',
    ];

    let foundTable = null as string | null;
    for (const t of candidates) {
      const [[tableExists]] = await sequelize.query(
        `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = '${t}' AND TABLE_SCHEMA = DATABASE()`
      );
      if (tableExists) {
        foundTable = t;
        break;
      }
    }

    if (!foundTable) {
      console.log(`Table not found among candidates: ${candidates.join(', ')}. Abort.`);
      process.exit(0);
    }

    console.log('Found tenant users table:', foundTable);

    const [[col]] = await sequelize.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = '${foundTable}' AND COLUMN_NAME = 'invitationTokenExpiresAt' AND TABLE_SCHEMA = DATABASE()`
    );

    if (!col) {
      console.log(`Altering table ${foundTable}: add column invitationTokenExpiresAt`);
      await queryInterface.addColumn(foundTable, 'invitationTokenExpiresAt', {
        type: DataTypes.DATE,
        allowNull: true,
      });
    } else {
      console.log('Column invitationTokenExpiresAt already exists.');
    }

    console.log('✅ Migration completed successfully.');
    process.exit(0);
  } catch (error) {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  }
}

migrate();
