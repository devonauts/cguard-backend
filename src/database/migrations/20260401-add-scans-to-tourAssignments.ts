require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

async function migrate() {
  const { sequelize } = models();
  const queryInterface: QueryInterface = sequelize.getQueryInterface();

  try {
    console.log('Starting migration: add scansCompleted and completedAt to tourAssignments...');

    const [[tableExists]] = await sequelize.query(
      `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'tourAssignments' AND TABLE_SCHEMA = DATABASE()`
    );

    if (!tableExists) {
      console.log('Table tourAssignments does not exist — creating minimal table with new fields.');
      await queryInterface.createTable('tourAssignments', {
        id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
        scansCompleted: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
        completedAt: { type: DataTypes.DATE, allowNull: true },
        createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: sequelize.literal('CURRENT_TIMESTAMP') },
        updatedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: sequelize.literal('CURRENT_TIMESTAMP') },
      });
      console.log('Created tourAssignments with scans fields.');
      process.exit(0);
    }

    const addIfMissing = async (colName: string, def: any) => {
      const [col] = await sequelize.query(
        `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'tourAssignments' AND COLUMN_NAME = '${colName}' AND TABLE_SCHEMA = DATABASE()`
      );
      if ((col as any[]).length === 0) {
        console.log(`Adding column ${colName} to tourAssignments`);
        await queryInterface.addColumn('tourAssignments', colName, def);
      } else {
        console.log(`Column ${colName} already exists, skipping`);
      }
    };

    await addIfMissing('scansCompleted', { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 });
    await addIfMissing('completedAt', { type: DataTypes.DATE, allowNull: true });

    console.log('✅ Migration completed successfully.');
    process.exit(0);
  } catch (error) {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  }
}

migrate();
