/**
 * Add supervisor-dispatch state to incidents:
 *  - dispatchStatus (dispatched | accepted | enRoute | onScene | null)
 *  - dispatchedAt
 * Additive/nullable → no impact on existing rows. Idempotent.
 *
 * Run: npx ts-node src/database/migrations/20260705b-add-incident-dispatch.ts
 */
require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

async function migrate() {
  const { sequelize } = models();
  const qi: QueryInterface = sequelize.getQueryInterface();
  let desc: any = {};
  try { desc = await qi.describeTable('incidents'); } catch { process.exit(0); }

  if (!('dispatchStatus' in desc)) {
    await qi.addColumn('incidents', 'dispatchStatus', { type: DataTypes.STRING(16), allowNull: true });
    console.log('Added incidents.dispatchStatus');
  } else { console.log('incidents.dispatchStatus exists, skipping'); }

  if (!('dispatchedAt' in desc)) {
    await qi.addColumn('incidents', 'dispatchedAt', { type: DataTypes.DATE, allowNull: true });
    console.log('Added incidents.dispatchedAt');
  } else { console.log('incidents.dispatchedAt exists, skipping'); }

  process.exit(0);
}

migrate().catch((err) => { console.error('Migration failed:', err); process.exit(1); });
