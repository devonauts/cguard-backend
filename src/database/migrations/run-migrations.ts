import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { getConfig } from '../../config';
import { spawn } from 'child_process';

/**
 * Migration runner WITH a run-once ledger.
 *
 * Previously this ran EVERY migration file on every `migrate:all`, with no
 * record of what had already run. That replayed the entire history each deploy —
 * including one-off "cleanup/drop" scripts — so e.g. an old script that dropped
 * `commercialName` kept firing right after the add-migrations re-created it.
 *
 * Now each applied migration is recorded in `migrations_applied`; a migration is
 * skipped if it's already there. On an EXISTING database that predates this
 * ledger (no rows yet but core tables present) we BASELINE — mark every current
 * migration as applied without re-running it — so the historical one-offs can
 * never fire again. A fresh database (no core tables) runs everything once.
 */
async function run() {
  dotenv.config();
  // Ensure a dialect is set before importing any migration files / models.
  const rawDial = (process.env.DATABASE_DIALECT || getConfig().DATABASE_DIALECT || 'mysql');
  const cleaned = (typeof rawDial === 'string' ? rawDial.trim().toLowerCase() : rawDial) || 'mysql';
  const resolvedDialect = ['undefined', 'null', ''].includes(cleaned) ? 'mysql' : cleaned;
  process.env.DATABASE_DIALECT = resolvedDialect;
  console.log('run-migrations: using DATABASE_DIALECT=', process.env.DATABASE_DIALECT);

  const migrationsDir = path.resolve(__dirname);
  console.log('Migrations dir:', migrationsDir);

  const files = fs.readdirSync(migrationsDir)
    .filter(f => f.endsWith('.ts') || f.endsWith('.js'))
    .filter(f => !f.includes('run-migrations') && f !== 'create.ts')
    .sort();

  if (!files.length) {
    console.log('No migration files found.');
    process.exit(0);
  }

  // ── Ledger setup ───────────────────────────────────────────────────────────
  const models = require('../models').default;
  const { sequelize } = models();

  await sequelize.query(
    `CREATE TABLE IF NOT EXISTS migrations_applied (
       name VARCHAR(255) NOT NULL PRIMARY KEY,
       appliedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
     )`,
  );

  const [appliedRows]: any = await sequelize.query(`SELECT name FROM migrations_applied`);
  const applied = new Set<string>((appliedRows || []).map((r: any) => r.name));

  const markApplied = async (file: string) => {
    try {
      await sequelize.query(`INSERT IGNORE INTO migrations_applied (name) VALUES (?)`, {
        replacements: [file],
      });
      applied.add(file);
    } catch (e) {
      console.warn(`Could not record migration ${file} in ledger:`, (e as any)?.message || e);
    }
  };

  // First time the ledger exists: if this is an EXISTING database (core tables
  // already present), baseline every current migration as applied and run none.
  if (applied.size === 0) {
    const [coreRows]: any = await sequelize.query(
      `SELECT COUNT(*) AS c FROM information_schema.tables
        WHERE table_schema = DATABASE() AND table_name IN ('tenants','clientAccounts','users')`,
    );
    const isExistingDb = Number(coreRows?.[0]?.c || 0) > 0;
    if (isExistingDb) {
      for (const f of files) await markApplied(f);
      console.log(`Baselined ${files.length} existing migration(s) as applied — none re-run.`);
      console.log('Future deploys will only run NEW migrations.');
      process.exit(0);
    }
    console.log('Fresh database detected — running all migrations once.');
  }

  // ── Run pending migrations only ────────────────────────────────────────────
  const benignPatterns = [
    'duplicate key name', 'er_dup_keyname', 'duplicate column name',
    'already exists', 'duplicate entry', 'column already exists', 'index already exists',
  ];

  for (const file of files) {
    if (applied.has(file)) {
      console.log('— skip (already applied):', file);
      continue;
    }

    const full = path.join(migrationsDir, file);
    console.log('\n--- Running migration:', file, '---');

    try {
      await new Promise<void>((resolve, reject) => {
        const childEnv = Object.assign({}, process.env, {
          DATABASE_DIALECT: process.env.DATABASE_DIALECT,
        });
        const child = spawn('npx', ['ts-node', full], { env: childEnv, stdio: 'pipe', shell: true });

        let stdout = '';
        let stderr = '';
        if (child.stdout) child.stdout.on('data', (c) => { const s = c.toString(); stdout += s; process.stdout.write(s); });
        if (child.stderr) child.stderr.on('data', (c) => { const s = c.toString(); stderr += s; process.stderr.write(s); });

        child.on('error', (err) => reject(err));
        child.on('close', (code) => {
          const combined = (stdout + '\n' + stderr).toLowerCase();
          const isBenign = benignPatterns.some((p) => combined.includes(p));
          if (code === 0) resolve();
          else if (isBenign) {
            console.warn(`Migration ${file} failed with a benign error; continuing.`);
            resolve();
          } else reject(new Error(`migration process exited with code ${code}`));
        });
      });

      await markApplied(file);
      console.log(`✅ Migration ${file} applied + recorded.`);
    } catch (err) {
      console.error(`❌ Migration ${file} failed:`, err);
      process.exit(1);
    }
  }

  console.log('\nAll pending migrations executed.');
  process.exit(0);
}

run().catch(err => {
  console.error('Migration runner failed', err);
  process.exit(1);
});
