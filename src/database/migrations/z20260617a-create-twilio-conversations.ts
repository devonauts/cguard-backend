require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

/**
 * Platform Twilio phone center: create twilioConversations — one SMS thread per
 * (peerNumber, ourNumber) pair on the single platform number. Idempotent.
 */
async function migrate() {
  const { sequelize } = models();
  const qi: QueryInterface = sequelize.getQueryInterface();

  try {
    const [[tableExists]]: any = await sequelize.query(
      `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'twilioConversations' AND TABLE_SCHEMA = DATABASE()`,
    );
    if (tableExists) {
      console.log('Table twilioConversations already exists. Skipping.');
      process.exit(0);
    }

    console.log('Creating twilioConversations table...');
    await qi.createTable('twilioConversations', {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      peerNumber: { type: DataTypes.STRING(32), allowNull: false },
      ourNumber: { type: DataTypes.STRING(32), allowNull: true },
      lastMessageAt: { type: DataTypes.DATE, allowNull: true },
      lastMessagePreview: { type: DataTypes.STRING(255), allowNull: true },
      unreadCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      status: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'open' },
      createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: sequelize.fn('NOW') },
      updatedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: sequelize.fn('NOW') },
    });

    await qi.addIndex('twilioConversations', ['peerNumber'], { name: 'twilio_conv_peer' });

    console.log('✅ twilioConversations created.');
    process.exit(0);
  } catch (error) {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  }
}

export { migrate };

migrate();
