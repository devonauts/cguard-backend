require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

/**
 * FEATURE #23 — create notificationPreferences. Per-customer (clientAccount)
 * mute/unmute of a CATEGORY of customer-app push notifications (incidents,
 * messages, coverage, visitors, patrols, support, documents, digest, sos).
 *
 * clientNotifyService reads these rows before sending a customer push and SKIPS
 * the push when a row says enabled=false. Default = ENABLED (absent row = send,
 * fail-open). Unique on (clientAccountId, category). Idempotent: skips if the
 * table already exists.
 */
async function migrate() {
  const { sequelize } = models();
  const queryInterface: QueryInterface = sequelize.getQueryInterface();

  try {
    let tableExists = true;
    try { await queryInterface.describeTable('notificationPreferences'); } catch { tableExists = false; }
    if (!tableExists) {
      console.log('Creating notificationPreferences table...');
      await queryInterface.createTable('notificationPreferences', {
        id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
        clientAccountId: { type: DataTypes.UUID, allowNull: false },
        userId: { type: DataTypes.UUID, allowNull: true },
        category: { type: DataTypes.STRING(40), allowNull: false },
        enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
        tenantId: {
          type: DataTypes.UUID, allowNull: false,
          references: { model: 'tenants', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE',
        },
        createdById: { type: DataTypes.UUID, allowNull: true },
        updatedById: { type: DataTypes.UUID, allowNull: true },
        createdAt: { type: DataTypes.DATE, allowNull: false },
        updatedAt: { type: DataTypes.DATE, allowNull: false },
        deletedAt: { type: DataTypes.DATE, allowNull: true },
      });
      await queryInterface.addIndex('notificationPreferences', ['clientAccountId', 'category'], {
        unique: true,
        name: 'notificationPreferences_clientAccount_category_unique',
      });
      await queryInterface.addIndex('notificationPreferences', ['tenantId', 'clientAccountId']);
      console.log('✅ notificationPreferences table created');
    } else {
      console.log('Table notificationPreferences already exists, skipping creation');
    }

    process.exit(0);
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  }
}

export { migrate };

migrate();
