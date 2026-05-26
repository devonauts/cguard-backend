#!/usr/bin/env node
/**
 * deployMigrateAndVerify.ts
 *
 * Usage: run this on the server in the backend repo root with:
 *   npx ts-node ./src/tools/deployMigrateAndVerify.ts
 *
 * Actions:
 *  - Loads .env (if present)
 *  - Optionally creates a mysqldump backup (if mysqldump present and DB vars set)
 *  - Runs `npm run migrate:all`
 *  - Verifies that `commercialName` column exists and reports counts
 *  - Attempts to reload PM2 app `cguard-backend` (or reload ecosystem.config.js)
 *
 * This script is conservative and logs outputs for diagnostics.
 */

import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { spawnSync } from 'child_process';
import mysql from 'mysql2/promise';

dotenv.config();

const REPO_DIR = process.cwd();
const BACKUP_DIR = path.join(REPO_DIR, 'backups');
const PM2_APP_NAME = process.env.PM2_APP_NAME || 'cguard-backend';

function runSync(cmd: string, args: string[], opts: any = {}) {
  console.log(`=> Running: ${cmd} ${args.join(' ')}`);
  const res = spawnSync(cmd, args, { stdio: 'inherit', shell: false, ...opts });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} exited with code ${res.status}`);
  }
}

async function backupDatabaseIfPossible() {
  const { DATABASE_HOST, DATABASE_PORT, DATABASE_USERNAME, DATABASE_PASSWORD, DATABASE_DATABASE } = process.env;
  if (!DATABASE_DATABASE) {
    console.log('=> DATABASE_DATABASE not set - skipping DB backup');
    return;
  }

  // check mysqldump availability
  try {
    const which = spawnSync('which', ['mysqldump']);
    if (which.status !== 0) {
      console.log('=> mysqldump not found in path - skipping DB backup');
      return;
    }
  } catch (e) {
    console.log('=> which mysqldump check failed - skipping backup');
    return;
  }

  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const dumpFile = path.join(BACKUP_DIR, `db-backup-${ts}.sql`);

  console.log(`=> Creating DB backup to ${dumpFile} (mysqldump)`);
  const args = [
    `-h`, DATABASE_HOST || '127.0.0.1',
    `-P`, DATABASE_PORT || '3306',
    `-u`, DATABASE_USERNAME || 'root',
    `-p${DATABASE_PASSWORD || ''}`,
    DATABASE_DATABASE,
  ];

  const res = spawnSync('mysqldump', args, { stdio: ['ignore', fs.openSync(dumpFile, 'w'), 'inherit'], shell: false });
  if (res.error || res.status !== 0) {
    console.warn('=> mysqldump reported an error (exit ' + res.status + ') - backup may be incomplete');
  } else {
    console.log('=> DB backup finished');
  }
}

async function runMigrations() {
  console.log('=> Running migrations: npm run migrate:all');
  // Use spawnSync to run npm in a blocking way and forward output
  try {
    runSync('npm', ['run', 'migrate:all'], { cwd: REPO_DIR });
    console.log('=> migrate:all finished successfully');
  } catch (err) {
    console.error('=> migrate:all failed:', err && (err as Error).message);
    throw err;
  }
}

async function verifyCommercialName() {
  const { DATABASE_HOST, DATABASE_PORT, DATABASE_USERNAME, DATABASE_PASSWORD, DATABASE_DATABASE } = process.env;
  if (!DATABASE_DATABASE) {
    console.warn('=> DATABASE_DATABASE not set - cannot verify commercialName');
    return;
  }

  console.log('=> Verifying commercialName column in DB...');
  const conn = await mysql.createConnection({
    host: DATABASE_HOST || '127.0.0.1',
    port: Number(DATABASE_PORT || 3306),
    user: DATABASE_USERNAME || 'root',
    password: DATABASE_PASSWORD || '',
    database: DATABASE_DATABASE,
  });

  try {
    const [rows] = await conn.query(
      `SELECT COLUMN_NAME, COLUMN_TYPE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'clientAccounts' AND COLUMN_NAME = 'commercialName'`,
      [DATABASE_DATABASE]
    );

    if ((rows as any).length === 0) {
      console.warn('=> Column commercialName NOT FOUND in clientAccounts');
    } else {
      console.log('=> Column commercialName FOUND:', (rows as any)[0]);
    }

    // report counts
    try {
      const [countRows] = await conn.query(`SELECT COUNT(*) AS total, SUM(CASE WHEN commercialName IS NULL OR commercialName = '' THEN 1 ELSE 0 END) AS missingCommercial FROM clientAccounts`);
      console.log('=> clientAccounts counts:', (countRows as any)[0]);
    } catch (e) {
      console.warn('=> Could not fetch counts (maybe column missing):', e && (e as Error).message);
    }
  } finally {
    await conn.end();
  }
}

async function reloadPm2() {
  console.log('=> Attempting to reload PM2 app');
  try {
    // Prefer reloading ecosystem config; fallback to restarting app name
    try {
      runSync('pm2', ['reload', 'ecosystem.config.js', '--env', 'production']);
      console.log('=> PM2 reload ecosystem.config.js succeeded');
      return;
    } catch (e) {
      console.log('=> pm2 reload ecosystem failed, trying pm2 restart app name');
    }

    try {
      runSync('pm2', ['restart', PM2_APP_NAME]);
      console.log('=> PM2 restarted app:', PM2_APP_NAME);
    } catch (err) {
      console.warn('=> PM2 restart failed:', err && (err as Error).message);
    }
  } catch (e) {
    console.warn('=> PM2 operations failed or pm2 not installed in PATH');
  }
}

async function main() {
  console.log('--- deployMigrateAndVerify starting ---');
  try {
    // show current working dir and .env summary
    console.log('Repo dir:', REPO_DIR);
    console.log('Using DB:', process.env.DATABASE_DATABASE, '@', process.env.DATABASE_HOST);

    await backupDatabaseIfPossible();
    await runMigrations();
    await verifyCommercialName();
    await reloadPm2();

    console.log('--- deployMigrateAndVerify completed ---');
    process.exit(0);
  } catch (err) {
    console.error('deployMigrateAndVerify failed:', err && (err as Error).message);
    process.exit(1);
  }
}

main();
