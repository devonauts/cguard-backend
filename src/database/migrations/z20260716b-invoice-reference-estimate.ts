/**
 * invoices.referenceEstimateId — estimateService.convert() uses it as the
 * conversion idempotency/dedupe key, but the column never existed: the
 * already-converted findOne errored on real MySQL and retries created
 * DUPLICATE invoices. Idempotent.
 * Run: npx ts-node src/database/migrations/z20260716b-invoice-reference-estimate.ts
 */
require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

async function migrate() {
  const { sequelize } = models();
  const qi: QueryInterface = sequelize.getQueryInterface();
  const t: any = await qi.describeTable('invoices');

  if (!t.referenceEstimateId) {
    await qi.addColumn('invoices', 'referenceEstimateId', {
      type: DataTypes.UUID,
      allowNull: true,
    });
    console.log('✅ invoices.referenceEstimateId added');
  } else {
    console.log('↷ invoices.referenceEstimateId already exists');
  }
}

migrate()
  .then(() => { console.log('done'); process.exit(0); })
  .catch((e) => { console.error(e); process.exit(1); });
