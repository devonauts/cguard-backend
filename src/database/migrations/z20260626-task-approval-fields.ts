/**
 * Task approval workflow: a client creates a task for a station → CRM approves →
 * pushed to the worker app + tracked. Adds the workflow columns to `tasks`.
 *
 *   status            pending_approval | approved | rejected | completed | cancelled
 *   source            'client' | 'staff'
 *   priority          'alta' | 'media' | 'baja'
 *   approvedById      who approved/rejected (user)
 *   approvedAt        decision timestamp
 *   approvalNotes     decision / rejection reason
 *   clientAccountId   the client who created it (client-sourced tasks)
 *   completedByGuardId  the guard who completed it
 *
 * Backfill: existing rows → status='approved', source='staff' (they predate approval).
 * Idempotent.
 * Run: npx ts-node src/database/migrations/z20260626-task-approval-fields.ts
 */
require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

async function migrate() {
  const { sequelize } = models();
  const qi: QueryInterface = sequelize.getQueryInterface();
  const tables = await qi.showAllTables();
  const table = (tables as string[]).find((t) => /^tasks$/i.test(t)) || 'tasks';
  const desc = await qi.describeTable(table);

  const add = async (col: string, def: any) => {
    if (!desc[col]) {
      await qi.addColumn(table, col, def);
      console.log(`✅ Added ${col} to ${table}`);
    } else {
      console.log(`• ${col} already exists on ${table}, skipping`);
    }
  };

  await add('status', { type: DataTypes.STRING(30), allowNull: true, defaultValue: 'pending_approval' });
  await add('source', { type: DataTypes.STRING(20), allowNull: true });
  await add('priority', { type: DataTypes.STRING(10), allowNull: true, defaultValue: 'media' });
  await add('approvedById', { type: DataTypes.UUID, allowNull: true });
  await add('approvedAt', { type: DataTypes.DATE, allowNull: true });
  await add('approvalNotes', { type: DataTypes.TEXT, allowNull: true });
  await add('clientAccountId', { type: DataTypes.UUID, allowNull: true });
  await add('completedByGuardId', { type: DataTypes.UUID, allowNull: true });

  // Existing tasks predate the workflow → treat them as already-approved staff tasks.
  await sequelize.query(`UPDATE ${table} SET status='approved' WHERE status IS NULL`);
  await sequelize.query(`UPDATE ${table} SET source='staff' WHERE source IS NULL`);
  console.log('✅ Backfilled existing tasks → status=approved, source=staff');

  try {
    await qi.addIndex(table, ['tenantId', 'status'], { name: 'task_tenant_status_idx' });
    console.log('✅ Added index task_tenant_status_idx');
  } catch (e: any) {
    console.log('• index task_tenant_status_idx skipped:', e?.message || e);
  }

  process.exit(0);
}

migrate().catch((err) => { console.error(err); process.exit(1); });
