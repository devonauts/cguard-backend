require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

/**
 * Add clientAccounts.contractEndDate, riskLevel, code, accountExecutiveId —
 * surfaced on the client detail (contrato-fin, riesgo, código, ejecutivo
 * responsable) and editable in the CRM client form. Idempotent.
 */
async function migrate() {
  const { sequelize } = models();
  const qi: QueryInterface = sequelize.getQueryInterface();
  const cols: Array<[string, any]> = [
    ['contractEndDate', { type: DataTypes.DATEONLY, allowNull: true }],
    ['riskLevel', { type: DataTypes.STRING(20), allowNull: true }],
    ['code', { type: DataTypes.STRING(50), allowNull: true }],
    ['accountExecutiveId', { type: DataTypes.UUID, allowNull: true }],
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
