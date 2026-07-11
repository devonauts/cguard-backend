/**
 * Single active session PER APP CHANNEL for user accounts (seat enforcement):
 * add `users.activeSessionIds`.
 *
 * Holds a small JSON object mapping channel → session id, e.g.
 * {"web":"<uuid>","worker":"<uuid>"}. Sign-in rotates the id for its channel;
 * findByToken rejects tokens whose sid no longer matches (401
 * auth.sessionSuperseded) when ENFORCE_SINGLE_SESSION=true. Mirrors the
 * customer-app mechanism (clientAccount.activeSessionId, z20260630c) but
 * per-channel so one person keeps CRM web + their mobile app signed in while
 * a second device on the SAME channel supersedes the first. Idempotent.
 * Run: npx ts-node src/database/migrations/z20260711a-add-user-active-sessions.ts
 */
require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

async function migrate() {
  const { sequelize } = models();
  const qi: QueryInterface = sequelize.getQueryInterface();

  const desc: any = await qi.describeTable('users');
  if (!desc.activeSessionIds) {
    await qi.addColumn('users', 'activeSessionIds', {
      type: DataTypes.TEXT,
      allowNull: true,
    });
    console.log('✅ users.activeSessionIds added');
  } else {
    console.log('↷ users.activeSessionIds already exists');
  }
}

migrate()
  .then(() => { console.log('done'); process.exit(0); })
  .catch((e) => { console.error(e); process.exit(1); });
