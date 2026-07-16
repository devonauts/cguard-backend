/**
 * clientAccounts.contractDate — the CRM client form had a "Fecha de contrato"
 * input whose value was silently dropped (no column). Idempotent.
 * Run: npx ts-node src/database/migrations/z20260715a-client-contract-date.ts
 */
require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

async function migrate() {
  const { sequelize } = models();
  const qi: QueryInterface = sequelize.getQueryInterface();
  const t: any = await qi.describeTable('clientAccounts');
  if (!t.contractDate) {
    await qi.addColumn('clientAccounts', 'contractDate', {
      type: DataTypes.DATEONLY,
      allowNull: true,
    });
    console.log('✅ clientAccounts.contractDate added');
  } else {
    console.log('↷ clientAccounts.contractDate already exists');
  }
}

migrate()
  .then(() => { console.log('done'); process.exit(0); })
  .catch((e) => { console.error(e); process.exit(1); });
