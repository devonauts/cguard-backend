require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

/**
 * Unified communications (Meta WhatsApp): create whatsappInboundSessions —
 * tracks lastInboundAt per (tenantId, phone) so the provider can honor Meta's
 * 24h customer-service window (free-form text only while open; template
 * otherwise). Idempotent — create guarded by INFORMATION_SCHEMA.
 */
async function migrate() {
  const { sequelize } = models();
  const qi: QueryInterface = sequelize.getQueryInterface();

  try {
    const [[tableExists]]: any = await sequelize.query(
      `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'whatsappInboundSessions' AND TABLE_SCHEMA = DATABASE()`,
    );

    if (!tableExists) {
      console.log('Creating whatsappInboundSessions table...');
      await qi.createTable('whatsappInboundSessions', {
        id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
        tenantId: { type: DataTypes.UUID, allowNull: false },
        phone: { type: DataTypes.STRING(32), allowNull: false },
        lastInboundAt: { type: DataTypes.DATE, allowNull: true },
        createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: sequelize.fn('NOW') },
        updatedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: sequelize.fn('NOW') },
      });
      await qi.addIndex('whatsappInboundSessions', ['tenantId', 'phone'], {
        unique: true,
        name: 'whatsapp_inbound_sessions_tenant_phone_uq',
      });
      console.log('✅ whatsappInboundSessions created.');
    } else {
      console.log('Table whatsappInboundSessions already exists. Skipping create.');
    }

    console.log('Migration z20260616f-create-whatsapp-inbound-sessions complete.');
    process.exit(0);
  } catch (error) {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  }
}

export { migrate };

migrate();
