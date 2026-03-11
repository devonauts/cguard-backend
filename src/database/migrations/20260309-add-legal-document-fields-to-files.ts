require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

async function migrate() {
  const { sequelize } = models();
  const queryInterface: QueryInterface = sequelize.getQueryInterface();

  try {
    console.log('Starting migration: add legal document support to files table...');

    const [[tableExists]] = await sequelize.query(
      `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'files' AND TABLE_SCHEMA = DATABASE()`
    );

    if (!tableExists) {
      console.log('Table files does not exist. Abort.');
      process.exit(0);
    }

    // Add tenantId if not exists
    const [tenantIdResult] = await sequelize.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'files' AND COLUMN_NAME = 'tenantId' AND TABLE_SCHEMA = DATABASE()`
    );
    if ((tenantIdResult as any[]).length === 0) {
      console.log('Adding column: tenantId');
      await queryInterface.addColumn('files', 'tenantId', {
        type: DataTypes.UUID,
        allowNull: true,
      });
    } else {
      console.log('Column tenantId already exists, skipping.');
    }

    // Add createdById if not exists
    const [createdByIdResult] = await sequelize.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'files' AND COLUMN_NAME = 'createdById' AND TABLE_SCHEMA = DATABASE()`
    );
    if ((createdByIdResult as any[]).length === 0) {
      console.log('Adding column: createdById');
      await queryInterface.addColumn('files', 'createdById', {
        type: DataTypes.UUID,
        allowNull: true,
      });
    } else {
      console.log('Column createdById already exists, skipping.');
    }

    // Add updatedById if not exists
    const [updatedByIdResult] = await sequelize.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'files' AND COLUMN_NAME = 'updatedById' AND TABLE_SCHEMA = DATABASE()`
    );
    if ((updatedByIdResult as any[]).length === 0) {
      console.log('Adding column: updatedById');
      await queryInterface.addColumn('files', 'updatedById', {
        type: DataTypes.UUID,
        allowNull: true,
      });
    } else {
      console.log('Column updatedById already exists, skipping.');
    }

    // Add type (mimeType) if not exists
    const [typeResult] = await sequelize.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'files' AND COLUMN_NAME = 'mimeType' AND TABLE_SCHEMA = DATABASE()`
    );
    if ((typeResult as any[]).length === 0) {
      console.log('Adding column: mimeType');
      await queryInterface.addColumn('files', 'mimeType', {
        type: DataTypes.STRING(255),
        allowNull: true,
      });
    } else {
      console.log('Column mimeType already exists, skipping.');
    }

    // Add legalDocument boolean if not exists
    const [legalDocResult] = await sequelize.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'files' AND COLUMN_NAME = 'isLegalDocument' AND TABLE_SCHEMA = DATABASE()`
    );
    if ((legalDocResult as any[]).length === 0) {
      console.log('Adding column: isLegalDocument');
      await queryInterface.addColumn('files', 'isLegalDocument', {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      });
    } else {
      console.log('Column isLegalDocument already exists, skipping.');
    }

    console.log('✅ Migration completed.');
    process.exit(0);
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  }
}

migrate();
