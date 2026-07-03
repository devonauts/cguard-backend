/**
 * Adds the richer create-task fields used by the supervisor app's Create Task
 * screen: a longer `description`, an optional `assignedGuardId` (assign to a
 * specific guard, not just the station), and `repeatConfig` (JSON for the
 * repeat rule). Photo/video attachments reuse the existing `imageOptional`
 * file relation; the voice note uses a new `voiceNote` file relation (no column
 * — files are polymorphic). Idempotent.
 *
 * Run: npx ts-node src/database/migrations/z20260703-add-task-create-fields.ts
 */
require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

async function migrate() {
  const { sequelize } = models();
  const qi: QueryInterface = sequelize.getQueryInterface();
  const describe = await qi.describeTable('tasks');

  const add = async (name: string, spec: any) => {
    if (name in describe) {
      console.log(`tasks.${name} already exists, skipping`);
      return;
    }
    await qi.addColumn('tasks', name, spec);
    console.log(`Added tasks.${name}`);
  };

  await add('description', { type: DataTypes.TEXT, allowNull: true });
  await add('assignedGuardId', { type: DataTypes.UUID, allowNull: true });
  await add('repeatConfig', { type: DataTypes.TEXT, allowNull: true });

  process.exit(0);
}

migrate().catch((e) => {
  console.error(e);
  process.exit(1);
});
