import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { getConfig } from '../../config';
import { spawn } from 'child_process';
async function run() {
  dotenv.config();
  // Ensure a dialect is set before importing any migration files.
  // Some migrations (or modules they import) instantiate Sequelize
  // at module-eval time and require `process.env.DATABASE_DIALECT`.
  // Normalize/clean dialect values: ignore literal strings like 'undefined'/'null'.
  const rawDial = (process.env.DATABASE_DIALECT || getConfig().DATABASE_DIALECT || 'mysql');
  const cleaned = (typeof rawDial === 'string' ? rawDial.trim().toLowerCase() : rawDial) || 'mysql';
  const resolvedDialect = ['undefined', 'null', ''].includes(cleaned) ? 'mysql' : cleaned;
  process.env.DATABASE_DIALECT = resolvedDialect;
  console.log('run-migrations: using DATABASE_DIALECT=', process.env.DATABASE_DIALECT);
  const migrationsDir = path.resolve(__dirname);
  console.log('Migrations dir:', migrationsDir);

  const files = fs.readdirSync(migrationsDir)
    .filter(f => f.endsWith('.ts') || f.endsWith('.js'))
    .filter(f => !f.includes('run-migrations'))
    .sort();

  if (!files.length) {
    console.log('No migration files found.');
    process.exit(0);
  }

  for (const file of files) {
    const full = path.join(migrationsDir, file);
    console.log('\n--- Running migration:', file, '---');

    // Run each migration in a separate process to isolate module-level
    // imports (some migrations import application `models` which may
    // initialize Sequelize at import time). We use `npx ts-node` so
    // TypeScript files run directly.
    try {
      await new Promise<void>((resolve, reject) => {
        const childEnv = Object.assign({}, process.env, {
          DATABASE_DIALECT: process.env.DATABASE_DIALECT,
        });
        // Run the migration in a child process but capture stdout/stderr so
        // we can detect and tolerate common benign errors (duplicate index/column/table)
        const child = spawn('npx', ['ts-node', full], {
          env: childEnv,
          stdio: 'pipe',
          shell: true,
        });

        let stdout = '';
        let stderr = '';

        if (child.stdout) {
          child.stdout.on('data', (chunk) => {
            const s = chunk.toString();
            stdout += s;
            process.stdout.write(s);
          });
        }

        if (child.stderr) {
          child.stderr.on('data', (chunk) => {
            const s = chunk.toString();
            stderr += s;
            process.stderr.write(s);
          });
        }

        child.on('error', (err) => reject(err));
        child.on('close', (code) => {
          const combined = (stdout + '\n' + stderr).toLowerCase();

          // Common benign error patterns we can ignore and continue
          const benignPatterns = [
            'duplicate key name',
            'er_dup_keyname',
            'duplicate column name',
            'already exists',
            'duplicate entry',
            'column already exists',
            'index already exists',
          ];

          const isBenign = benignPatterns.some((p) => combined.includes(p));

          if (code === 0) {
            resolve();
          } else if (isBenign) {
            console.warn(`Migration ${file} failed with a benign error; continuing. (see output above)`);
            resolve();
          } else {
            reject(new Error(`migration process exited with code ${code}`));
          }
        });
      });

      console.log(`✅ Migration ${file} executed (child process).`);
    } catch (err) {
      console.error(`❌ Migration ${file} failed:`, err);
      process.exit(1);
    }
  }

  console.log('\nAll migrations executed.');
  process.exit(0);
}

run().catch(err => {
  console.error('Migration runner failed', err);
  process.exit(1);
});
