require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

/**
 * Make description, contactPhone, contactEmail, and address nullable in businessInfos.
 * The post-site creation form only collects name + description, so requiring the
 * other contact fields up-front was blocking creates when the client record lacks them.
 */
async function migrate() {
  const { sequelize } = models();
  const queryInterface: QueryInterface = sequelize.getQueryInterface();

  try {
    console.log('Altering businessInfos columns to allow null...');

    const cols = await queryInterface.describeTable('businessInfos');

    const alterIfNeeded = async (colName: string) => {
      const col = cols[colName];
      if (!col) {
        console.log(`Column ${colName} not found, skipping`);
        return;
      }
      if (col.allowNull === false) {
        await queryInterface.changeColumn('businessInfos', colName, {
          type: DataTypes.TEXT,
          allowNull: true,
          defaultValue: null,
        });
        console.log(`  ✓ ${colName} → allowNull: true`);
      } else {
        console.log(`  ✓ ${colName} already nullable, skipping`);
      }
    };

    await alterIfNeeded('description');
    await alterIfNeeded('contactPhone');
    await alterIfNeeded('contactEmail');
    await alterIfNeeded('address');

    console.log('Done.');
    process.exit(0);
  } catch (err) {
    console.error('Migration failed:', err);
    process.exit(1);
  }
}

migrate();
