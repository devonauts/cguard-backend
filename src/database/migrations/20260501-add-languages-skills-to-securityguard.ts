require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

async function migrate() {
  const { sequelize } = models();
  const queryInterface: QueryInterface = sequelize.getQueryInterface();

  try {
    console.log('Starting migration: add languages and skills to securityGuards...');

    const [[tableExists]] = await sequelize.query(
      `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'securityGuards' AND TABLE_SCHEMA = DATABASE()`
    );

    if (!tableExists) {
      console.log('Table securityGuards does not exist. Abort.');
      process.exit(0);
    }

    const [langResult] = await sequelize.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'securityGuards' AND COLUMN_NAME = 'languages' AND TABLE_SCHEMA = DATABASE()`
    );

    if ((langResult as any[]).length === 0) {
      console.log('Adding column: languages');
      await queryInterface.addColumn('securityGuards', 'languages', {
        type: DataTypes.JSON,
        allowNull: true,
        defaultValue: [],
      });
    } else {
      console.log('Column languages already exists, skipping.');
    }

    const [skillsResult] = await sequelize.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'securityGuards' AND COLUMN_NAME = 'skills' AND TABLE_SCHEMA = DATABASE()`
    );

    if ((skillsResult as any[]).length === 0) {
      console.log('Adding column: skills');
      await queryInterface.addColumn('securityGuards', 'skills', {
        type: DataTypes.JSON,
        allowNull: true,
        defaultValue: [],
      });
    } else {
      console.log('Column skills already exists, skipping.');
    }

    console.log('Migration complete.');
    process.exit(0);
  } catch (err) {
    console.error('Migration failed:', err);
    process.exit(1);
  }
}

migrate();
