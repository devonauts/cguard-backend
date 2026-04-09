require('dotenv').config();
import models from '../database/models';

async function run() {
  const db = models();
  try {
    console.log('DB config:', {
      DB: process.env.DATABASE_DATABASE,
      HOST: process.env.DATABASE_HOST,
      USER: process.env.DATABASE_USERNAME,
      DIALECT: process.env.DATABASE_DIALECT,
      PORT: process.env.DATABASE_PORT,
    });
    await db.sequelize.authenticate();
    console.log('DB connected');
    const [cols] = await db.sequelize.query('SHOW COLUMNS FROM visitorLogs');
    console.log('visitorLogs columns:');
    (cols as any).forEach((c: any) => console.log(`- ${c.Field} (${c.Type})`));

    const [results] = await db.sequelize.query(
      'SELECT id, visitDate FROM visitorLogs ORDER BY createdAt DESC LIMIT 5',
    );

    if (!results || (results as any).length === 0) {
      console.log('No visitorLogs rows found');
      process.exit(0);
    }

    console.log('Sample visitorLogs (id, visitDate):');
    (results as any).forEach((r: any) => {
      console.log(`- id=${r.id} visitDate=${r.visitDate}`);
    });
  } catch (err) {
    console.error('Error querying DB', err);
    process.exit(1);
  } finally {
    try { await db.sequelize.close(); } catch (e) {}
  }
}

run();
