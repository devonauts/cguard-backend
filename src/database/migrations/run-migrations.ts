import fs from 'fs';
import path from 'path';

async function run() {
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
    try {
      // Use dynamic import so the migration's top-level code executes
      const imported = await import(full);
      // If the migration exports a `migrate` function, call it for safety
      if (imported && typeof imported.migrate === 'function') {
        await imported.migrate();
      }
      console.log(`✅ Migration ${file} executed (imported).`);
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
