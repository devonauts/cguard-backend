require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

async function migrate() {
  const { sequelize } = models();
  const queryInterface: QueryInterface = sequelize.getQueryInterface();

  try {
    let tableExists = true;
    try {
      await queryInterface.describeTable('radioDevices');
    } catch (err) {
      tableExists = false;
    }

    if (tableExists) {
      console.log('Table radioDevices already exists, skipping creation');
      process.exit(0);
    }

    console.log('Creating radioDevices table...');

    await queryInterface.createTable('radioDevices', {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      name: { type: DataTypes.STRING(160), allowNull: false },
      host: { type: DataTypes.STRING(160), allowNull: true },
      sipPort: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 5060 },
      transport: { type: DataTypes.STRING(8), allowNull: false, defaultValue: 'udp' },
      sipUsername: { type: DataTypes.STRING(120), allowNull: true },
      sipPassword: { type: DataTypes.STRING(512), allowNull: true },
      sipDomain: { type: DataTypes.STRING(160), allowNull: true },
      registerRequired: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      extension: { type: DataTypes.STRING(80), allowNull: true },
      codec: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'pcmu' },
      rtpPortStart: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 16000 },
      rtpPortEnd: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 16100 },
      status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'unknown' },
      lastSeenAt: { type: DataTypes.DATE, allowNull: true },
      lastError: { type: DataTypes.TEXT, allowNull: true },
      postSiteId: { type: DataTypes.UUID, allowNull: true },
      stationId: { type: DataTypes.UUID, allowNull: true },
      notes: { type: DataTypes.TEXT, allowNull: true },
      active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      importHash: { type: DataTypes.STRING(255), allowNull: true },
      tenantId: {
        type: DataTypes.UUID,
        allowNull: false,
        references: { model: 'tenants', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      createdById: { type: DataTypes.UUID, allowNull: true },
      updatedById: { type: DataTypes.UUID, allowNull: true },
      createdAt: { type: DataTypes.DATE, allowNull: false },
      updatedAt: { type: DataTypes.DATE, allowNull: false },
      deletedAt: { type: DataTypes.DATE, allowNull: true },
    });

    await queryInterface.addIndex('radioDevices', ['tenantId']);
    await queryInterface.addIndex('radioDevices', ['active']);

    console.log('✅ radioDevices table created');
    process.exit(0);
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  }
}

export { migrate };

migrate();
