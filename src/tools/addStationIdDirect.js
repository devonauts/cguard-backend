require('dotenv').config();
const mysql = require('mysql2/promise');

async function run() {
  const cfg = {
    host: process.env.DB_HOST || process.env.HOST || '127.0.0.1',
    user: process.env.DB_USERNAME || process.env.USER || process.env.USERNAME || 'root',
    password: process.env.DB_PASSWORD || process.env.PASSWORD || '',
    database: process.env.DB || process.env.DB_NAME || 'cguard',
    port: process.env.DB_PORT || 3306,
  };

  console.log('Connecting to DB', { host: cfg.host, database: cfg.database, user: cfg.user });

  const conn = await mysql.createConnection({ host: cfg.host, user: cfg.user, password: cfg.password, database: cfg.database, port: cfg.port });
  try {
    console.log('Running ALTER TABLE to add stationId...');
    await conn.query('ALTER TABLE `visitorLogs` ADD COLUMN `stationId` CHAR(36) NULL;');
    console.log('ALTER TABLE executed successfully');
  } catch (err) {
    console.log('ALTER TABLE error:', err.message || err);
  } finally {
    await conn.end();
  }
}

run().catch((e) => {
  console.error('Script error:', e.message || e);
  process.exit(1);
});
