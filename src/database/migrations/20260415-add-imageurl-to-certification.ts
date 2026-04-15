require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

async function migrate() {
  const { sequelize } = models();
  const queryInterface: QueryInterface = sequelize.getQueryInterface();

  try {
    console.log('Starting migration: add imageUrl to certification table...');

    const [[tableExists]] = await sequelize.query(
      `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'certifications' AND TABLE_SCHEMA = DATABASE()`
    );

    if (!tableExists) {
      console.log('Table certifications does not exist. Abort.');
      process.exit(0);
    }

    const [imageUrlResult] = await sequelize.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'certifications' AND COLUMN_NAME = 'imageUrl' AND TABLE_SCHEMA = DATABASE()`
    );

    if ((imageUrlResult as any[]).length === 0) {
      console.log('Adding column: imageUrl');
      await queryInterface.addColumn('certifications', 'imageUrl', {
        type: DataTypes.STRING(2083),
        allowNull: true,
      });
    } else {
      console.log('Column imageUrl already exists, skipping.');
    }

    const [iconUrlResult] = await sequelize.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'certifications' AND COLUMN_NAME = 'iconUrl' AND TABLE_SCHEMA = DATABASE()`
    );

    if ((iconUrlResult as any[]).length === 0) {
      console.log('Adding column: iconUrl');
      await queryInterface.addColumn('certifications', 'iconUrl', {
        type: DataTypes.STRING(2083),
        allowNull: true,
      });
    } else {
      console.log('Column iconUrl already exists, skipping.');
    }

    console.log('✅ Migration completed.');
    process.exit(0);
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  }
}

migrate();
