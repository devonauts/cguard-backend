require('dotenv').config();
import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

async function migrate() {
  const { sequelize } = models();
  const queryInterface: QueryInterface = sequelize.getQueryInterface();

  try {
    const tables = await queryInterface.showAllTables();

    if (!tables.includes('clientProjects')) {
      await queryInterface.createTable('clientProjects', {
        id: {
          type: DataTypes.UUID,
          defaultValue: DataTypes.UUIDV4,
          primaryKey: true,
          allowNull: false,
        },
        tenantId: {
          type: DataTypes.UUID,
          allowNull: false,
        },
        clientAccountId: {
          type: DataTypes.UUID,
          allowNull: false,
        },
        businessInfoId: {
          type: DataTypes.UUID,
          allowNull: true,
        },
        name: {
          type: DataTypes.STRING(200),
          allowNull: false,
        },
        type: {
          type: DataTypes.STRING(50),
          allowNull: false,
          defaultValue: 'event',
        },
        description: {
          type: DataTypes.TEXT,
          allowNull: true,
        },
        status: {
          type: DataTypes.STRING(30),
          allowNull: false,
          defaultValue: 'active',
        },
        startDate: {
          type: DataTypes.DATEONLY,
          allowNull: true,
        },
        endDate: {
          type: DataTypes.DATEONLY,
          allowNull: true,
        },
        location: {
          type: DataTypes.STRING(300),
          allowNull: true,
        },
        estimatedHours: {
          type: DataTypes.DECIMAL(10, 2),
          allowNull: true,
        },
        assignedGuards: {
          type: DataTypes.JSON,
          allowNull: true,
        },
        notes: {
          type: DataTypes.TEXT,
          allowNull: true,
        },
        createdAt: {
          type: DataTypes.DATE,
          allowNull: false,
        },
        updatedAt: {
          type: DataTypes.DATE,
          allowNull: false,
        },
      });
      console.log('✓ Created clientProjects table');
    } else {
      console.log('✓ clientProjects already exists, skipping');
    }

    console.log('Done.');
    process.exit(0);
  } catch (err) {
    console.error('Migration failed:', err);
    process.exit(1);
  }
}

migrate();
