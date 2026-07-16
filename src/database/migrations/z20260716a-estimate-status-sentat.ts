/**
 * estimates.status + estimates.sentAt — estimateService.send() marks the
 * estimate as { status: 'Enviado', sentAt } but the columns never existed
 * (the patch was silently dropped), so estimates never showed as sent.
 * Mirrors the invoice model's status/sentAt shape. Idempotent.
 * Run: npx ts-node src/database/migrations/z20260716a-estimate-status-sentat.ts
 */
require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

async function migrate() {
  const { sequelize } = models();
  const qi: QueryInterface = sequelize.getQueryInterface();
  const t: any = await qi.describeTable('estimates');

  if (!t.status) {
    await qi.addColumn('estimates', 'status', {
      type: DataTypes.STRING(50),
      allowNull: true,
      defaultValue: 'Borrador',
    });
    console.log('✅ estimates.status added');
  } else {
    console.log('↷ estimates.status already exists');
  }

  if (!t.sentAt) {
    await qi.addColumn('estimates', 'sentAt', {
      type: DataTypes.DATE,
      allowNull: true,
    });
    console.log('✅ estimates.sentAt added');
  } else {
    console.log('↷ estimates.sentAt already exists');
  }
}

migrate()
  .then(() => { console.log('done'); process.exit(0); })
  .catch((e) => { console.error(e); process.exit(1); });
