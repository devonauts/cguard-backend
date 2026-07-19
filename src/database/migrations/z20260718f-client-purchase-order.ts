require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

/**
 * Add `purchaseOrder` (orden de compra, optional) to `clientAccounts` — used
 * when the client is a public/state entity contracting via purchase order.
 * Idempotent. Run: npx ts-node src/database/migrations/z20260718f-client-purchase-order.ts
 */
async function migrate() {
  const { sequelize } = models();
  const qi: QueryInterface = sequelize.getQueryInterface();
  try {
    const [rows]: any = await sequelize.query(
      `SELECT COUNT(*) as c FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'clientAccounts' AND COLUMN_NAME = 'purchaseOrder'`,
    );
    if (rows && rows[0] && Number(rows[0].c) > 0) {
      console.log('clientAccounts.purchaseOrder already exists, skipping.');
    } else {
      await qi.addColumn('clientAccounts', 'purchaseOrder', { type: DataTypes.STRING(120), allowNull: true });
      console.log('✅ clientAccounts.purchaseOrder added');
    }
    process.exit(0);
  } catch (error) {
    console.error('❌ migration failed:', error);
    process.exit(1);
  }
}

migrate();
