require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

/**
 * Create the visitorPreAuthorizations table backing the visitor pre-authorization
 * + QR feature: the CUSTOMER app pre-registers a visitor and gets a qrToken; the
 * WORKER/guard app scans it and (on a valid scan) materialises a real visitorLog.
 * Standalone-script style, idempotent.
 */
async function migrate() {
  const { sequelize } = models();
  const queryInterface: QueryInterface = sequelize.getQueryInterface();

  try {
    let tableExists = true;
    try {
      await queryInterface.describeTable('visitorPreAuthorizations');
    } catch {
      tableExists = false;
    }

    if (tableExists) {
      console.log('↩︎  visitorPreAuthorizations already exists, skipping creation');
      process.exit(0);
    }

    console.log('Creating visitorPreAuthorizations table...');
    await queryInterface.createTable('visitorPreAuthorizations', {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      clientAccountId: { type: DataTypes.UUID, allowNull: false },
      stationId: { type: DataTypes.UUID, allowNull: true },
      postSiteId: { type: DataTypes.UUID, allowNull: true },
      visitorFirstName: { type: DataTypes.STRING(255), allowNull: false },
      visitorLastName: { type: DataTypes.STRING(255), allowNull: true },
      visitorIdNumber: { type: DataTypes.STRING(255), allowNull: true },
      reason: { type: DataTypes.TEXT, allowNull: true },
      company: { type: DataTypes.STRING(255), allowNull: true },
      vehiclePlate: { type: DataTypes.STRING(30), allowNull: true },
      validFrom: { type: DataTypes.DATE, allowNull: true },
      validUntil: { type: DataTypes.DATE, allowNull: true },
      qrToken: { type: DataTypes.STRING(255), allowNull: false, unique: true },
      status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'active' },
      usedAt: { type: DataTypes.DATE, allowNull: true },
      usedByGuardId: { type: DataTypes.UUID, allowNull: true },
      createdVisitorLogId: { type: DataTypes.UUID, allowNull: true },
      createdById: { type: DataTypes.UUID, allowNull: true },
      updatedById: { type: DataTypes.UUID, allowNull: true },
      tenantId: {
        type: DataTypes.UUID,
        allowNull: false,
        references: { model: 'tenants', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      createdAt: { type: DataTypes.DATE, allowNull: false },
      updatedAt: { type: DataTypes.DATE, allowNull: false },
      deletedAt: { type: DataTypes.DATE, allowNull: true },
    });

    await queryInterface.addIndex('visitorPreAuthorizations', ['qrToken'], {
      unique: true,
      name: 'visitorPreAuthorizations_qrToken_unique',
    });
    await queryInterface.addIndex('visitorPreAuthorizations', ['tenantId']);
    await queryInterface.addIndex('visitorPreAuthorizations', ['clientAccountId']);

    console.log('✅ visitorPreAuthorizations table created');
    process.exit(0);
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  }
}

export { migrate };

migrate();
