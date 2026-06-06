require('dotenv').config();

import fs from 'fs';
import path from 'path';
import models from '../models';

function listSqlFiles(baseDir: string): string[] {
  const files: string[] = [];

  const direct = fs.readdirSync(baseDir)
    .filter((f) => f.endsWith('.sql'))
    .map((f) => path.join(baseDir, f));

  const sqlDir = path.join(baseDir, 'sql');
  const nested = fs.existsSync(sqlDir)
    ? fs.readdirSync(sqlDir)
      .filter((f) => f.endsWith('.sql'))
      .map((f) => path.join(sqlDir, f))
    : [];

  files.push(...direct, ...nested);
  return files.sort();
}

function isBenignSqlError(message: string): boolean {
  const m = message.toLowerCase();
  return [
    'duplicate column name',
    'already exists',
    'duplicate key name',
    'er_dup_keyname',
    'duplicate entry',
    'unknown column',
    'cannot drop',
    'check that column/key exists',
    'doesn\'t exist',
    'foreign key constraint',
    'errno: 1826',
  ].some((p) => m.includes(p));
}

function splitSqlStatements(sql: string): string[] {
  return sql
    .replace(/--.*$/gm, '')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
}

async function runSqlMigrations() {
  const db = models() as any;
  const sequelize = db.sequelize;
  const baseDir = path.resolve(__dirname);
  const files = listSqlFiles(baseDir);

  if (!files.length) {
    console.log('No SQL migrations found.');
    await sequelize.close();
    return;
  }

  for (const fullPath of files) {
    const file = path.relative(baseDir, fullPath);
    const sql = fs.readFileSync(fullPath, 'utf8').trim();

    if (!sql) {
      console.log(`Skipping empty SQL migration: ${file}`);
      continue;
    }

    console.log(`Running SQL migration: ${file}`);
    const statements = splitSqlStatements(sql);

    for (const stmt of statements) {
      try {
        await sequelize.query(stmt);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (isBenignSqlError(msg)) {
          console.warn(`SQL migration ${file} produced benign error on statement, continuing: ${msg}`);
        } else {
          await sequelize.close();
          throw new Error(`SQL migration failed (${file}): ${msg}`);
        }
      }
    }

    console.log(`SQL migration executed: ${file}`);
  }

  await sequelize.close();
  console.log('All SQL migrations executed.');
}

runSqlMigrations().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
