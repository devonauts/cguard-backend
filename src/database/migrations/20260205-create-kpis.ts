require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

async function migrate() {
  const { sequelize } = models();
  const queryInterface: QueryInterface = sequelize.getQueryInterface();

  try {
    console.log('Creating kpis table...');

    await queryInterface.createTable('kpis', {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      scope: {
        type: DataTypes.STRING(50),
        allowNull: false,
      },
      guardId: {
        type: DataTypes.UUID,
        allowNull: true,
      },
      postSiteId: {
        type: DataTypes.UUID,
        allowNull: true,
      },
      frequency: {
        type: DataTypes.STRING(50),
        allowNull: true,
      },
      description: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
      // Explicit report flags and counts from frontend modal
      standardReports: {
        type: DataTypes.BOOLEAN,
        defaultValue: true,
      },
      standardReportsNumber: {
        type: DataTypes.INTEGER,
        allowNull: true,
      },
      incidentReports: {
        type: DataTypes.BOOLEAN,
        defaultValue: true,
      },
      incidentReportsNumber: {
        type: DataTypes.INTEGER,
        allowNull: true,
      },
      routeReports: {
        type: DataTypes.BOOLEAN,
        defaultValue: true,
      },
      routeReportsNumber: {
        type: DataTypes.INTEGER,
        allowNull: true,
      },
      taskReports: {
        type: DataTypes.BOOLEAN,
        defaultValue: true,
      },
      taskReportsNumber: {
        type: DataTypes.INTEGER,
        allowNull: true,
      },
      verificationReports: {
        type: DataTypes.BOOLEAN,
        defaultValue: true,
      },
      verificationReportsNumber: {
        type: DataTypes.INTEGER,
        allowNull: true,
      },
      reportOptions: {
        type: DataTypes.JSON,
        allowNull: true,
      },
      emailNotification: {
        type: DataTypes.BOOLEAN,
        defaultValue: false,
      },
      emails: {
        type: DataTypes.JSON,
        allowNull: true,
      },
      active: {
        type: DataTypes.BOOLEAN,
        defaultValue: true,
      },
      tenantId: {
        type: DataTypes.UUID,
        allowNull: false,
        references: {
          model: 'tenants',
          key: 'id',
        },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      createdById: {
        type: DataTypes.UUID,
        allowNull: true,
      },
      updatedById: {
        type: DataTypes.UUID,
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
      deletedAt: {
        type: DataTypes.DATE,
        allowNull: true,
      },
    });

    console.log('Creating indexes for kpis...');
    await queryInterface.addIndex('kpis', ['scope', 'guardId']);
    await queryInterface.addIndex('kpis', ['scope', 'postSiteId']);
    await queryInterface.addIndex('kpis', ['tenantId']);

    console.log('✅ kpis created');
    process.exit(0);
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  }
}

migrate();
