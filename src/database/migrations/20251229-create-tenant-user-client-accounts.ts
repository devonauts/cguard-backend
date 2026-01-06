require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

async function migrate() {
  const { sequelize } = models();
  const queryInterface: QueryInterface = sequelize.getQueryInterface();

  try {
    console.log('Creating tenant_user_client_accounts table...');

    await queryInterface.createTable('tenant_user_client_accounts', {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      tenantUserId: {
        type: DataTypes.UUID,
        allowNull: false,
        references: {
          model: 'tenantUsers',
          key: 'id',
        },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      clientAccountId: {
        type: DataTypes.UUID,
        allowNull: false,
        references: {
          model: 'clientAccounts',
          key: 'id',
        },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
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

    console.log('Creating indexes for tenant_user_client_accounts...');
    await queryInterface.addIndex('tenant_user_client_accounts', ['tenantUserId', 'clientAccountId'], {
      unique: true,
      name: 'tenant_user_client_unique',
    });
    await queryInterface.addIndex('tenant_user_client_accounts', ['tenantUserId']);
    await queryInterface.addIndex('tenant_user_client_accounts', ['clientAccountId']);

    console.log('✅ tenant_user_client_accounts created');
    process.exit(0);
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  }
}

migrate();
