require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

async function migrate() {
  const { sequelize } = models();
  const queryInterface: QueryInterface = sequelize.getQueryInterface();

  try {
    console.log('Adding fields to requests table...');

    const tableDesc = await queryInterface.describeTable('requests');

    if (!tableDesc['incidentAt']) {
      await queryInterface.addColumn('requests', 'incidentAt', {
        type: DataTypes.DATE,
        allowNull: true,
      });
    } else {
      console.log('Column incidentAt already exists, skipping');
    }

    if (!tableDesc['clientId']) {
      await queryInterface.addColumn('requests', 'clientId', {
        type: DataTypes.UUID,
        allowNull: true,
        references: {
          model: 'clientAccounts',
          key: 'id',
        },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      });
    } else {
      console.log('Column clientId already exists, skipping');
    }

    if (!tableDesc['siteId']) {
      await queryInterface.addColumn('requests', 'siteId', {
        type: DataTypes.UUID,
        allowNull: true,
        references: {
          model: 'businessInfos',
          key: 'id',
        },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      });
    } else {
      console.log('Column siteId already exists, skipping');
    }

    if (!tableDesc['incidentTypeId']) {
      await queryInterface.addColumn('requests', 'incidentTypeId', {
        type: DataTypes.UUID,
        allowNull: true,
        references: {
          model: 'incidentTypes',
          key: 'id',
        },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      });
    } else {
      console.log('Column incidentTypeId already exists, skipping');
    }

    if (!tableDesc['priority']) {
      await queryInterface.addColumn('requests', 'priority', {
        type: DataTypes.STRING(50),
        allowNull: true,
      });
    } else {
      console.log('Column priority already exists, skipping');
    }

    if (!tableDesc['callerType']) {
      await queryInterface.addColumn('requests', 'callerType', {
        type: DataTypes.STRING(100),
        allowNull: true,
      });
    } else {
      console.log('Column callerType already exists, skipping');
    }

    if (!tableDesc['callerName']) {
      await queryInterface.addColumn('requests', 'callerName', {
        type: DataTypes.STRING(255),
        allowNull: true,
      });
    } else {
      console.log('Column callerName already exists, skipping');
    }

    if (!tableDesc['location']) {
      await queryInterface.addColumn('requests', 'location', {
        type: DataTypes.TEXT,
        allowNull: true,
      });
    } else {
      console.log('Column location already exists, skipping');
    }

    if (!tableDesc['internalNotes']) {
      await queryInterface.addColumn('requests', 'internalNotes', {
        type: DataTypes.TEXT,
        allowNull: true,
      });
    } else {
      console.log('Column internalNotes already exists, skipping');
    }

    if (!tableDesc['status']) {
      await queryInterface.addColumn('requests', 'status', {
        type: DataTypes.STRING(50),
        allowNull: false,
        defaultValue: 'abierto',
      });
    } else {
      console.log('Column status already exists, skipping');
    }

    console.log('✅ Added request fields');
    process.exit(0);
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  }
}

migrate();
