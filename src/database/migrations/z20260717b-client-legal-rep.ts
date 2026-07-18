require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

/**
 * Add the LEGAL REPRESENTATIVE person fields to clientAccounts — distinct from
 * the company entity. For a persona jurídica the client fields hold the empresa
 * (razón social / RUC) and these hold the rep (nombre, apellido, correo +
 * teléfono PERSONAL, cédula). Idempotent.
 */
async function migrate() {
  const { sequelize } = models();
  const qi: QueryInterface = sequelize.getQueryInterface();
  const cols: Array<[string, any]> = [
    ['legalRepFirstName', { type: DataTypes.STRING(150), allowNull: true }],
    ['legalRepLastName', { type: DataTypes.STRING(150), allowNull: true }],
    ['legalRepEmail', { type: DataTypes.STRING(200), allowNull: true }],
    ['legalRepPhone', { type: DataTypes.STRING(30), allowNull: true }],
    ['legalRepDocument', { type: DataTypes.STRING(20), allowNull: true }],
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
