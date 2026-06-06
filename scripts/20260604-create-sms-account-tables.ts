/**
 * Create the per-tenant SMS account + transaction ledger tables.
 * Run: npx ts-node scripts/20260604-create-sms-account-tables.ts
 */
require('dotenv').config();

import models from '../src/database/models';
import { QueryInterface, DataTypes } from 'sequelize';

async function migrate() {
  const { sequelize } = models();
  const qi: QueryInterface = sequelize.getQueryInterface();
  const tables = (await qi.showAllTables()) as string[];

  const has = (name: string) => tables.some((t) => t.toLowerCase() === name.toLowerCase());

  if (!has('tenantSmsAccounts')) {
    await qi.createTable('tenantSmsAccounts', {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      subaccountSid: { type: DataTypes.STRING(64), allowNull: true },
      authTokenEnc: { type: DataTypes.TEXT, allowNull: true },
      phoneNumber: { type: DataTypes.STRING(32), allowNull: true },
      messagingServiceSid: { type: DataTypes.STRING(64), allowNull: true },
      balanceCents: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      currency: { type: DataTypes.STRING(8), allowNull: false, defaultValue: 'USD' },
      status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'inactive' },
      tenantId: { type: DataTypes.UUID, allowNull: false },
      createdAt: { type: DataTypes.DATE, allowNull: false },
      updatedAt: { type: DataTypes.DATE, allowNull: false },
      deletedAt: { type: DataTypes.DATE, allowNull: true },
    });
    await qi.addIndex('tenantSmsAccounts', ['tenantId'], { name: 'sms_account_tenant', unique: false });
    console.log('✅ Created tenantSmsAccounts');
  } else {
    console.log('tenantSmsAccounts already exists, skipping');
  }

  if (!has('smsTransactions')) {
    await qi.createTable('smsTransactions', {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      type: { type: DataTypes.STRING(12), allowNull: false },
      amountCents: { type: DataTypes.INTEGER, allowNull: false },
      balanceAfterCents: { type: DataTypes.INTEGER, allowNull: true },
      smsCount: { type: DataTypes.INTEGER, allowNull: true },
      currency: { type: DataTypes.STRING(8), allowNull: false, defaultValue: 'USD' },
      reference: { type: DataTypes.STRING(128), allowNull: true },
      description: { type: DataTypes.STRING(255), allowNull: true },
      tenantId: { type: DataTypes.UUID, allowNull: false },
      createdAt: { type: DataTypes.DATE, allowNull: false },
      updatedAt: { type: DataTypes.DATE, allowNull: false },
      deletedAt: { type: DataTypes.DATE, allowNull: true },
    });
    await qi.addIndex('smsTransactions', ['tenantId', 'createdAt'], { name: 'sms_tx_tenant_created' });
    await qi.addIndex('smsTransactions', ['reference'], { name: 'sms_tx_reference' });
    console.log('✅ Created smsTransactions');
  } else {
    console.log('smsTransactions already exists, skipping');
  }

  process.exit(0);
}

migrate().catch((err) => {
  console.error(err);
  process.exit(1);
});
