require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

async function migrate() {
  const { sequelize } = models();
  const queryInterface: QueryInterface = sequelize.getQueryInterface();

  try {
    console.log('Adding assignment fields to tenant_user_post_sites...');
    // Describe table and add columns only if they don't exist yet
    let tableDesc = await queryInterface.describeTable('tenant_user_post_sites');

    const addIfNotExists = async (colName: string, options: any) => {
      if (!tableDesc[colName]) {
        await queryInterface.addColumn('tenant_user_post_sites', colName, options);
        console.log(`Added column ${colName}`);
        // refresh table description to reflect newly added column (keep correct types)
        tableDesc = await queryInterface.describeTable('tenant_user_post_sites');
      } else {
        console.log(`Column ${colName} already exists, skipping`);
      }
    };

    await addIfNotExists('site_tours', {
      type: DataTypes.JSON,
      allowNull: true,
    });

    await addIfNotExists('tasks', {
      type: DataTypes.JSON,
      allowNull: true,
    });

    await addIfNotExists('post_orders', {
      type: DataTypes.JSON,
      allowNull: true,
    });

    await addIfNotExists('checklists', {
      type: DataTypes.JSON,
      allowNull: true,
    });

    await addIfNotExists('skill_set', {
      type: DataTypes.JSON,
      allowNull: true,
    });

    await addIfNotExists('department', {
      type: DataTypes.JSON,
      allowNull: true,
    });

    console.log('✅ tenant_user_post_sites assignment fields added');
    process.exit(0);
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  }
}

migrate();
