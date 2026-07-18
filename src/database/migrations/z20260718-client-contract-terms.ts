require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

/**
 * Add CONTRACT & SLA term columns to clientAccounts — powers the "Contrato y
 * servicios" client subpage. Purely operational contract metadata (no billing /
 * no amounts — the product deliberately has no tenant-facing invoicing). SLA
 * fields are the AGREED targets; live compliance is computed from operations.
 *
 * Idempotent. Run: npx ts-node src/database/migrations/z20260718-client-contract-terms.ts
 */
async function migrate() {
  const { sequelize } = models();
  const qi: QueryInterface = sequelize.getQueryInterface();

  const cols: Array<[string, any]> = [
    ['contractNumber', { type: DataTypes.STRING(60), allowNull: true }],
    ['contractType', { type: DataTypes.STRING(80), allowNull: true }],
    ['currency', { type: DataTypes.STRING(10), allowNull: true }],
    ['paymentTerms', { type: DataTypes.STRING(40), allowNull: true }],
    ['autoRenew', { type: DataTypes.BOOLEAN, allowNull: true, defaultValue: false }],
    ['autoRenewDaysBefore', { type: DataTypes.INTEGER, allowNull: true }],
    ['penaltyClause', { type: DataTypes.STRING(255), allowNull: true }],
    ['earlyCancellationNotice', { type: DataTypes.STRING(255), allowNull: true }],
    ['jurisdiction', { type: DataTypes.STRING(120), allowNull: true }],
    ['contractedHoursPerMonth', { type: DataTypes.INTEGER, allowNull: true }],
    ['contractNotes', { type: DataTypes.TEXT, allowNull: true }],
    // SLA agreed targets (percentages / minutes)
    ['slaUptimeTarget', { type: DataTypes.INTEGER, allowNull: true }],
    ['slaResponseMinutes', { type: DataTypes.INTEGER, allowNull: true }],
    ['slaRoundsTarget', { type: DataTypes.INTEGER, allowNull: true }],
    ['slaReportsTarget', { type: DataTypes.INTEGER, allowNull: true }],
  ];

  try {
    for (const [name, spec] of cols) {
      const [rows]: any = await sequelize.query(
        `SELECT COUNT(*) as c FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'clientAccounts' AND COLUMN_NAME = '${name}'`,
      );
      if (rows && rows[0] && Number(rows[0].c) > 0) {
        console.log(`clientAccounts.${name} already exists, skipping.`);
      } else {
        await qi.addColumn('clientAccounts', name, spec);
        console.log(`✅ clientAccounts.${name} added`);
      }
    }
    process.exit(0);
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  }
}

export { migrate };

migrate();
