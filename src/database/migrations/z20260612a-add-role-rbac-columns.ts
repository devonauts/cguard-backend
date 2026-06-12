require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

/**
 * RBAC overhaul (PR-1) — add isSystem / isCustomized to the roles table.
 *   isSystem     — true for built-in roles seeded per tenant (editable, never deletable)
 *   isCustomized — true once a tenant edits a system role away from its static defaults
 * Idempotent: skips columns that already exist.
 */
async function migrate() {
  const { sequelize } = models();
  const qi: QueryInterface = sequelize.getQueryInterface();

  try {
    const table = await qi.describeTable('roles');

    if (!table.isSystem) {
      console.log('Adding roles.isSystem...');
      await qi.addColumn('roles', 'isSystem', {
        type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false,
      });
      console.log('✅ roles.isSystem added');
    } else { console.log('roles.isSystem exists, skipping'); }

    if (!table.isCustomized) {
      console.log('Adding roles.isCustomized...');
      await qi.addColumn('roles', 'isCustomized', {
        type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false,
      });
      console.log('✅ roles.isCustomized added');
    } else { console.log('roles.isCustomized exists, skipping'); }

    process.exit(0);
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  }
}

export { migrate };

migrate();
