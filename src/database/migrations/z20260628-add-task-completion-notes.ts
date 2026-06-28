/**
 * Task completion report: store what the guard typed they did when finishing a
 * task (worker app). The completion photo already lands on the taskCompletedImage
 * file relation; this adds the free-text note alongside it.
 *
 *   completionNotes   TEXT — the guard's "what I did" note
 *
 * Idempotent.
 * Run: npx ts-node src/database/migrations/z20260628-add-task-completion-notes.ts
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

  if (!desc['completionNotes']) {
    await qi.addColumn(table, 'completionNotes', { type: DataTypes.TEXT, allowNull: true });
    console.log(`✅ Added completionNotes to ${table}`);
  } else {
    console.log(`• completionNotes already exists on ${table}, skipping`);
  }

  process.exit(0);
}

migrate().catch((err) => {
  console.error(err);
  process.exit(1);
});
