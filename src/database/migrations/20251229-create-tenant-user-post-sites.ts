require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

async function migrate() {
  const { sequelize } = models();
  const queryInterface: QueryInterface = sequelize.getQueryInterface();

  try {
    console.log('Creating tenant_user_post_sites table...');

    await queryInterface.createTable('tenant_user_post_sites', {
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
      businessInfoId: {
        type: DataTypes.UUID,
        allowNull: false,
        references: {
          model: 'businessInfos',
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

    console.log('Creating indexes for tenant_user_post_sites...');
    await queryInterface.addIndex('tenant_user_post_sites', ['tenantUserId', 'businessInfoId'], {
      unique: true,
      name: 'tenant_user_post_sites_unique',
    });
    await queryInterface.addIndex('tenant_user_post_sites', ['tenantUserId']);
    await queryInterface.addIndex('tenant_user_post_sites', ['businessInfoId']);

    console.log('✅ tenant_user_post_sites created');
    process.exit(0);
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  }
}

migrate();
