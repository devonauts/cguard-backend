require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

/**
 * Platform Twilio phone center: create twilioCalls — one row per voice call
 * (inbound/outbound) through the superadmin softphone, keyed by Twilio call SID
 * and updated by voice status callbacks. Idempotent.
 */
async function migrate() {
  const { sequelize } = models();
  const qi: QueryInterface = sequelize.getQueryInterface();

  try {
    const [[tableExists]]: any = await sequelize.query(
      `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'twilioCalls' AND TABLE_SCHEMA = DATABASE()`,
    );
    if (tableExists) {
      console.log('Table twilioCalls already exists. Skipping.');
      process.exit(0);
    }

    console.log('Creating twilioCalls table...');
    await qi.createTable('twilioCalls', {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      callSid: { type: DataTypes.STRING(64), allowNull: false, unique: true },
      direction: { type: DataTypes.STRING(16), allowNull: false },
      fromNumber: { type: DataTypes.STRING(32), allowNull: true },
      toNumber: { type: DataTypes.STRING(32), allowNull: true },
      status: { type: DataTypes.STRING(24), allowNull: true },
      durationSec: { type: DataTypes.INTEGER, allowNull: true },
      startedAt: { type: DataTypes.DATE, allowNull: true },
      endedAt: { type: DataTypes.DATE, allowNull: true },
      recordingUrl: { type: DataTypes.STRING(512), allowNull: true },
      createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: sequelize.fn('NOW') },
      updatedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: sequelize.fn('NOW') },
    });

    await qi.addIndex('twilioCalls', ['callSid'], { name: 'twilio_call_sid' });

    console.log('✅ twilioCalls created.');
    process.exit(0);
  } catch (error) {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  }
}

export { migrate };

migrate();
