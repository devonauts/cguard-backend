require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

/**
 * Foundation (unified communications): create communicationLogs — one row per
 * outbound delivery attempt across push/whatsapp/sms/email. Idempotent.
 */
async function migrate() {
  const { sequelize } = models();
  const qi: QueryInterface = sequelize.getQueryInterface();

  try {
    const [[tableExists]]: any = await sequelize.query(
      `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'communicationLogs' AND TABLE_SCHEMA = DATABASE()`,
    );
    if (tableExists) {
      console.log('Table communicationLogs already exists. Skipping.');
      process.exit(0);
    }

    console.log('Creating communicationLogs table...');
    await qi.createTable('communicationLogs', {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      tenantId: {
        type: DataTypes.UUID,
        allowNull: false,
        references: { model: 'tenants', key: 'id' },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      },
      userId: { type: DataTypes.UUID, allowNull: true },
      recipient: { type: DataTypes.STRING(255), allowNull: true },
      channel: { type: DataTypes.STRING(16), allowNull: false },
      provider: { type: DataTypes.STRING(32), allowNull: true },
      messageType: { type: DataTypes.STRING(32), allowNull: false, defaultValue: 'generic' },
      status: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'queued' },
      providerMessageId: { type: DataTypes.STRING(128), allowNull: true },
      providerResponse: { type: DataTypes.JSON, allowNull: true },
      errorMessage: { type: DataTypes.TEXT, allowNull: true },
      costEstimateCents: { type: DataTypes.INTEGER, allowNull: true },
      billedAmountCents: { type: DataTypes.INTEGER, allowNull: true },
      currency: { type: DataTypes.STRING(8), allowNull: false, defaultValue: 'USD' },
      deepLink: { type: DataTypes.STRING(255), allowNull: true },
      createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: sequelize.fn('NOW') },
      updatedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: sequelize.fn('NOW') },
      deliveredAt: { type: DataTypes.DATE, allowNull: true },
      readAt: { type: DataTypes.DATE, allowNull: true },
      failedAt: { type: DataTypes.DATE, allowNull: true },
    });

    await qi.addIndex('communicationLogs', ['tenantId', 'createdAt']);
    await qi.addIndex('communicationLogs', ['providerMessageId']);

    console.log('✅ communicationLogs created.');
    process.exit(0);
  } catch (error) {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  }
}

export { migrate };

migrate();
