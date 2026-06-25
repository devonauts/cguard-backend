require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

/**
 * Make the onboarding fields of securityGuards NULLABLE so a draft/invited guard
 * (added with just name + email, profile filled later on registration) can be
 * created. They were NOT NULL, so the invite's draft-guard insert always failed —
 * orphaning the pending tenantUser and showing 0 guards. Idempotent.
 */
async function migrate() {
  const { sequelize } = models();
  const queryInterface: QueryInterface = sequelize.getQueryInterface();
  const cols: Array<[string, any]> = [
    ['governmentId', DataTypes.STRING(50)],
    ['gender', DataTypes.TEXT],
    ['bloodType', DataTypes.TEXT],
    ['birthDate', DataTypes.DATEONLY],
    ['maritalStatus', DataTypes.TEXT],
    ['academicInstruction', DataTypes.TEXT],
  ];
  try {
    for (const [name, type] of cols) {
      await queryInterface.changeColumn('securityGuards', name, { type, allowNull: true });
      console.log(`✅ securityGuards.${name} → NULLABLE`);
    }
    process.exit(0);
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  }
}

export { migrate };

migrate();
