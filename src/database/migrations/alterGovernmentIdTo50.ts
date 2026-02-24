require('dotenv').config();

import models from '../models';
import { getConfig } from '../../config';

async function run() {
  try {
    // Determine dialect first so models() (which constructs Sequelize)
    // has a defined dialect value available via getConfig/process.env.
    const dialect = (
      process.env.DATABASE_DIALECT || getConfig().DATABASE_DIALECT || 'mysql'
    ).toLowerCase();

    // Ensure environment is set for code that reads process.env inside models()
    process.env.DATABASE_DIALECT = dialect;

    console.log('Running alterGovernmentIdTo50 for dialect:', dialect);

    const db = models();
    const sequelize = db.sequelize;

    if (dialect === 'postgres' || dialect === 'postgresql') {
      console.log('Executing Postgres ALTER...');
      await sequelize.query(`ALTER TABLE "securityGuards" ALTER COLUMN "governmentId" TYPE VARCHAR(50);`);
      await sequelize.query(`ALTER TABLE "securityGuards" ALTER COLUMN "governmentId" SET NOT NULL;`);
    } else {
      // default to MySQL-compatible
      console.log('Executing MySQL ALTER...');
      await sequelize.query('ALTER TABLE `securityGuards` MODIFY COLUMN `governmentId` VARCHAR(50) NOT NULL;');
    }

    console.log('Done. Verify your schema and restart the server.');
    process.exit(0);
  } catch (err) {
    console.error('Migration failed:', err);
    process.exit(1);
  }
}

run();
