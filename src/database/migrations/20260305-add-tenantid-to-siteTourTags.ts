require('dotenv').config();

import { getConfig } from '../../config';
import { Sequelize } from 'sequelize';

async function run() {
  try {
    const dialect = (
      process.env.DATABASE_DIALECT || getConfig().DATABASE_DIALECT || 'mysql'
    ).toLowerCase();

    process.env.DATABASE_DIALECT = dialect;

    console.log('Running add-tenantid-to-siteTourTags for dialect:', dialect);

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
      await sequelize.query(`ALTER TABLE "siteTourTags" ADD COLUMN "tenantId" UUID NOT NULL;`);
      await sequelize.query(`CREATE INDEX IF NOT EXISTS "idx_siteTourTags_tenantId" ON "siteTourTags" ("tenantId");`);
    } else {
      console.log('Executing MySQL ALTER...');
      await sequelize.query('ALTER TABLE `siteTourTags` ADD COLUMN `tenantId` CHAR(36) NOT NULL;');
      await sequelize.query('ALTER TABLE `siteTourTags` ADD INDEX `idx_siteTourTags_tenantId` (`tenantId`);');
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
