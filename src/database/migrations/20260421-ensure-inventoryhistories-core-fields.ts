require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

async function migrate() {
  const { sequelize } = models();
  const queryInterface: QueryInterface = sequelize.getQueryInterface();

  try {
    console.log('Starting migration: ensure core fields exist on inventoryhistories');

    const [[tableExists]] = await sequelize.query(
      `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'inventoryhistories' AND TABLE_SCHEMA = DATABASE()`
    );

    if (!tableExists) {
      console.log('Table inventoryhistories does not exist. Skipping.');
      process.exit(0);
    }

    const ensureColumn = async (columnName: string, definition: any) => {
      const [col] = await sequelize.query(
        `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'inventoryhistories' AND COLUMN_NAME = '${columnName}' AND TABLE_SCHEMA = DATABASE()`
      );
      if ((col as any[]).length === 0) {
        console.log(`Adding column ${columnName} to inventoryhistories`);
        await queryInterface.addColumn('inventoryhistories', columnName, definition as any);
      } else {
        console.log(`inventoryhistories.${columnName} already exists, skipping`);
      }
    };

    // Core fields provided by user
    await ensureColumn('inventoryCheckedDate', {
      type: DataTypes.DATE,
      allowNull: true,
    });

    await ensureColumn('isComplete', {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    });

    await ensureColumn('observation', {
      type: DataTypes.TEXT,
      allowNull: true,
    });

    await ensureColumn('importHash', {
      type: DataTypes.STRING(255),
      allowNull: true,
    });

    // Audit timestamps
    await ensureColumn('createdAt', {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: sequelize.fn('NOW'),
    });

    await ensureColumn('updatedAt', {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: sequelize.fn('NOW'),
    });

    await ensureColumn('deletedAt', {
      type: DataTypes.DATE,
      allowNull: true,
    });

    // Foreign/id fields
    await ensureColumn('shiftOriginId', {
      type: DataTypes.UUID,
      allowNull: true,
    });

    await ensureColumn('inventoryOriginId', {
      type: DataTypes.UUID,
      allowNull: true,
    });

    await ensureColumn('tenantId', {
      type: DataTypes.UUID,
      allowNull: true,
    });

    await ensureColumn('createdById', {
      type: DataTypes.UUID,
      allowNull: true,
      references: { model: 'users', key: 'id' },
      onDelete: 'SET NULL',
      onUpdate: 'CASCADE',
    });

    await ensureColumn('updatedById', {
      type: DataTypes.UUID,
      allowNull: true,
      references: { model: 'users', key: 'id' },
      onDelete: 'SET NULL',
      onUpdate: 'CASCADE',
    });

    console.log('✅ Migration completed successfully.');
    process.exit(0);
  } catch (error) {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  }
}

migrate();
