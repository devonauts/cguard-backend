require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

/**
 * Platform Twilio phone center: create twilioMessages — one row per SMS/MMS in
 * a platform conversation (inbound from webhook, outbound from composer).
 * Idempotent.
 */
async function migrate() {
  const { sequelize } = models();
  const qi: QueryInterface = sequelize.getQueryInterface();

  try {
    const [[tableExists]]: any = await sequelize.query(
      `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'twilioMessages' AND TABLE_SCHEMA = DATABASE()`,
    );
    if (tableExists) {
      console.log('Table twilioMessages already exists. Skipping.');
      process.exit(0);
    }

    console.log('Creating twilioMessages table...');
    await qi.createTable('twilioMessages', {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      conversationId: {
        type: DataTypes.UUID,
        allowNull: false,
        references: { model: 'twilioConversations', key: 'id' },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      },
      direction: { type: DataTypes.STRING(16), allowNull: false },
      fromNumber: { type: DataTypes.STRING(32), allowNull: true },
      toNumber: { type: DataTypes.STRING(32), allowNull: true },
      body: { type: DataTypes.TEXT, allowNull: true },
      twilioSid: { type: DataTypes.STRING(64), allowNull: true },
      status: { type: DataTypes.STRING(24), allowNull: false, defaultValue: 'received' },
      mediaUrls: { type: DataTypes.JSON, allowNull: true },
      errorMessage: { type: DataTypes.TEXT, allowNull: true },
      createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: sequelize.fn('NOW') },
      updatedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: sequelize.fn('NOW') },
    });

    await qi.addIndex('twilioMessages', ['conversationId'], { name: 'twilio_msg_conv' });
    await qi.addIndex('twilioMessages', ['twilioSid'], { name: 'twilio_msg_sid' });

    console.log('✅ twilioMessages created.');
    process.exit(0);
  } catch (error) {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  }
}

export { migrate };

migrate();
