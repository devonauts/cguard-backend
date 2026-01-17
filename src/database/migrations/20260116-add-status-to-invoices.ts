require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

async function migrate() {
  const { sequelize } = models();
  const queryInterface: QueryInterface = sequelize.getQueryInterface();

  try {
    console.log('Starting migration: add status and sentAt columns to invoices...');

    const [[tableExists]] = await sequelize.query(
      `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'invoices' AND TABLE_SCHEMA = DATABASE()`
    );

    if (!tableExists) {
      console.log('Table invoices does not exist. Abort.');
      process.exit(0);
    }

    // Add status column if not exists
    const [[statusCol]] = await sequelize.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'invoices' AND COLUMN_NAME = 'status' AND TABLE_SCHEMA = DATABASE()`
    );

    if (!statusCol) {
      console.log('Altering table invoices: add column status');
      await queryInterface.addColumn('invoices', 'status', {
        type: DataTypes.STRING(50),
        allowNull: true,
        defaultValue: 'Borrador',
      });
    } else {
      console.log('Column status already exists.');
    }

    // Add sentAt column if not exists
    const [[sentCol]] = await sequelize.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'invoices' AND COLUMN_NAME = 'sentAt' AND TABLE_SCHEMA = DATABASE()`
    );

    if (!sentCol) {
      console.log('Altering table invoices: add column sentAt');
      await queryInterface.addColumn('invoices', 'sentAt', {
        type: DataTypes.DATE,
        allowNull: true,
      });
    } else {
      console.log('Column sentAt already exists.');
    }

    // Ensure subtotal and total columns have decimal precision (10,2)
    try {
      const dialect = sequelize.getDialect();
      console.log('DB dialect detected:', dialect);
      if (dialect === 'postgres') {
        console.log('Altering invoices.subtotal and invoices.total to numeric(10,2) for Postgres');
        await sequelize.query(`ALTER TABLE \"invoices\" ALTER COLUMN \"subtotal\" TYPE numeric(10,2) USING subtotal::numeric`);
        await sequelize.query(`ALTER TABLE \"invoices\" ALTER COLUMN \"total\" TYPE numeric(10,2) USING total::numeric`);
      } else if (dialect === 'mysql' || dialect === 'mariadb') {
        console.log('Altering invoices.subtotal and invoices.total to DECIMAL(10,2) for MySQL/MariaDB');
        await sequelize.query(`ALTER TABLE invoices MODIFY COLUMN subtotal DECIMAL(10,2)`);
        await sequelize.query(`ALTER TABLE invoices MODIFY COLUMN total DECIMAL(10,2)`);
      } else {
        console.log('Skipping subtotal/total type alteration for dialect:', dialect);
      }
    } catch (err: unknown) {
      const errMessage = err && typeof err === 'object' && 'message' in err ? (err as any).message : String(err);
      console.log('Warning: failed to alter subtotal/total columns precision:', errMessage);
    }

    console.log('✅ Migration completed successfully.');
    process.exit(0);
  } catch (error) {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  }
}

migrate();
