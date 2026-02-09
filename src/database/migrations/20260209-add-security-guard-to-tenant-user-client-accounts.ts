require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

async function migrate() {
  const { sequelize } = models();
  const queryInterface: QueryInterface = sequelize.getQueryInterface();

  try {
    console.log('Adding security_guard_id to tenant_user_client_accounts...');

    await queryInterface.addColumn('tenant_user_client_accounts', 'security_guard_id', {
      type: DataTypes.UUID,
      allowNull: true,
      references: {
        model: 'securityGuards',
        key: 'id',
      },
      onUpdate: 'CASCADE',
      onDelete: 'SET NULL',
    });

    await queryInterface.addIndex('tenant_user_client_accounts', ['security_guard_id']);

    console.log('✅ tenant_user_client_accounts.security_guard_id added');
    process.exit(0);
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  }
}

migrate();
