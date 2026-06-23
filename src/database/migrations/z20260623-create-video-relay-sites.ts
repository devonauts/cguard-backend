require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

async function migrate() {
  const { sequelize } = models();
  const queryInterface: QueryInterface = sequelize.getQueryInterface();

  try {
    // 1) videoRelaySites table (idempotent)
    let tableExists = true;
    try { await queryInterface.describeTable('videoRelaySites'); } catch { tableExists = false; }
    if (!tableExists) {
      console.log('Creating videoRelaySites table...');
      await queryInterface.createTable('videoRelaySites', {
        id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
        name: { type: DataTypes.STRING(160), allowNull: false },
        siteKey: { type: DataTypes.STRING(64), allowNull: false },
        publishToken: { type: DataTypes.STRING(512), allowNull: true },
        ingestProtocol: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'rtmps' },
        status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'unknown' },
        lastSeenAt: { type: DataTypes.DATE, allowNull: true },
        notes: { type: DataTypes.TEXT, allowNull: true },
        active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
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
      await queryInterface.addIndex('videoRelaySites', ['tenantId']);
      console.log('✅ videoRelaySites table created');
    } else {
      console.log('Table videoRelaySites already exists, skipping creation');
    }

    // 2) videoDevices: connectionMode + relaySiteId (idempotent column adds)
    const cols = await queryInterface.describeTable('videoDevices');
    if (!cols.connectionMode) {
      await queryInterface.addColumn('videoDevices', 'connectionMode', {
        type: DataTypes.STRING(20), allowNull: false, defaultValue: 'direct',
      });
      console.log('✅ videoDevices.connectionMode added');
    }
    if (!cols.relaySiteId) {
      await queryInterface.addColumn('videoDevices', 'relaySiteId', {
        type: DataTypes.UUID, allowNull: true,
      });
      console.log('✅ videoDevices.relaySiteId added');
    }

    process.exit(0);
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  }
}

export { migrate };

migrate();
