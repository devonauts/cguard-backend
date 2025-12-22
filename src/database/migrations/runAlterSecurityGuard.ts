import models from '../models';
import { getConfig } from '../../config';

async function run() {
  try {
    const db = models();
    const sequelize = db.sequelize;
    const dialect = (process.env.DATABASE_DIALECT || getConfig().DATABASE_DIALECT || 'mysql').toLowerCase();

    console.log('Running alter for dialect:', dialect);

    if (dialect === 'postgres' || dialect === 'postgresql') {
      console.log('Executing Postgres ALTER...');
      await sequelize.query(`ALTER TABLE "securityGuards" ALTER COLUMN "governmentId" TYPE VARCHAR(20);`);
      await sequelize.query(`ALTER TABLE "securityGuards" ALTER COLUMN "governmentId" SET NOT NULL;`);
    } else {
      // default to MySQL-compatible
      console.log('Executing MySQL ALTER...');
      await sequelize.query('ALTER TABLE `securityGuards` MODIFY COLUMN `governmentId` VARCHAR(20) NOT NULL;');
    }

    console.log('Done. Verify your schema and restart the server.');
    process.exit(0);
  } catch (err) {
    console.error('Migration failed:', err);
    process.exit(1);
  }
}

run();
