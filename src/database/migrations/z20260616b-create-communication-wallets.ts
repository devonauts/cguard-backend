require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

/**
 * Foundation (unified communications): create communicationWallets — prepaid
 * balance per tenant for paid channels (whatsapp/sms). Seeds balanceCents from
 * the legacy tenantSmsAccount where that table/column exists. Idempotent.
 */
async function migrate() {
  const { sequelize } = models();
  const qi: QueryInterface = sequelize.getQueryInterface();

  try {
    const [[tableExists]]: any = await sequelize.query(
      `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'communicationWallets' AND TABLE_SCHEMA = DATABASE()`,
    );

    if (!tableExists) {
      console.log('Creating communicationWallets table...');
      await qi.createTable('communicationWallets', {
        id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
        tenantId: {
          type: DataTypes.UUID,
          allowNull: false,
          unique: true,
          references: { model: 'tenants', key: 'id' },
          onDelete: 'CASCADE',
          onUpdate: 'CASCADE',
        },
        balanceCents: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
        currency: { type: DataTypes.STRING(8), allowNull: false, defaultValue: 'USD' },
        lowBalanceThresholdCents: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 500 },
        createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: sequelize.fn('NOW') },
        updatedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: sequelize.fn('NOW') },
      });
      console.log('✅ communicationWallets created.');
    } else {
      console.log('Table communicationWallets already exists. Skipping create.');
    }

    // Seed from legacy SMS wallet where present and not already seeded.
    const [[smsTable]]: any = await sequelize.query(
      `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'tenantSmsAccounts' AND TABLE_SCHEMA = DATABASE()`,
    );
    if (smsTable) {
      console.log('Seeding communicationWallets from tenantSmsAccounts.balanceCents...');
      await sequelize.query(`
        INSERT INTO communicationWallets (id, tenantId, balanceCents, currency, lowBalanceThresholdCents, createdAt, updatedAt)
        SELECT UUID(), s.tenantId, COALESCE(s.balanceCents, 0), COALESCE(s.currency, 'USD'), 500, NOW(), NOW()
        FROM tenantSmsAccounts s
        WHERE s.tenantId IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM communicationWallets w WHERE w.tenantId = s.tenantId)
      `);
      console.log('✅ Seed pass complete.');
    } else {
      console.log('tenantSmsAccounts not found — no wallet seeding needed.');
    }

    process.exit(0);
  } catch (error) {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  }
}

export { migrate };

migrate();
