require('dotenv').config();

// Use a local Sequelize instance in this migration to avoid importing
// the application's `models` module (which constructs Sequelize and
// may run before we ensure the dialect is set). This keeps the
// migration self-contained.
import { getConfig } from '../../config';
import { Sequelize } from 'sequelize';

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

    // Create a standalone Sequelize instance for this migration.
    const cfg = getConfig();
    const sequelize = new Sequelize(
      cfg.DATABASE_DATABASE,
      cfg.DATABASE_USERNAME,
      cfg.DATABASE_PASSWORD,
      {
        host: cfg.DATABASE_HOST,
        port: cfg.DATABASE_PORT || 3307,
        dialect: dialect as any,
        timezone: cfg.DATABASE_TIMEZONE || '+00:00',
        logging: false,
      },
    );

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
    await sequelize.close();
    process.exit(0);
  } catch (err) {
    console.error('Migration failed:', err);
    process.exit(1);
  }
}

run();
