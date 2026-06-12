require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

/**
 * RBAC overhaul (PR-1) — add tenantUsers.permissionOverrides (JSON).
 * Shape: { grant: [permissionId...], deny: [permissionId...] }
 * Per-user grant/revoke applied on top of role permissions (deny wins).
 * Idempotent.
 */
async function migrate() {
  const { sequelize } = models();
  const qi: QueryInterface = sequelize.getQueryInterface();

  try {
    const table = await qi.describeTable('tenantUsers');

    if (!table.permissionOverrides) {
      console.log('Adding tenantUsers.permissionOverrides...');
      await qi.addColumn('tenantUsers', 'permissionOverrides', {
        type: DataTypes.JSON, allowNull: true,
      });
      console.log('✅ tenantUsers.permissionOverrides added');
    } else { console.log('tenantUsers.permissionOverrides exists, skipping'); }

    process.exit(0);
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  }
}

export { migrate };

migrate();
