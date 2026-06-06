/**
 * Consolidate incident station/site FKs onto the canonical columns:
 *   stationIncidentsId  →  stationId
 *   siteId              →  postSiteId
 *
 * Backfills the canonical column from the alias (where the canonical is null),
 * then drops the alias columns. This also fixes a latent bug: guard-reported
 * incidents wrote only `stationId`, so they were missing from station/client
 * incident lists keyed on `stationIncidentsId` — now everything keys on stationId.
 *
 * Idempotent: skips an alias column that's already gone. Reversible: re-add the
 * columns + copy back from stationId/postSiteId.
 *
 * Run: npx ts-node src/database/migrations/20260606-incident-fk-consolidate.ts
 */
require('dotenv').config();

import models from '../models';
import { QueryInterface, QueryTypes } from 'sequelize';

async function migrate() {
  const { sequelize } = models();
  const qi: QueryInterface = sequelize.getQueryInterface();
  const table = 'incidents';

  let desc: any = {};
  try {
    desc = await qi.describeTable(table);
  } catch (e) {
    console.error(`table ${table} not found:`, (e as Error).message);
    process.exit(1);
  }

  // stationIncidentsId → stationId
  if (desc.stationIncidentsId) {
    await sequelize.query(
      `UPDATE \`${table}\` SET \`stationId\` = \`stationIncidentsId\` ` +
        `WHERE \`stationId\` IS NULL AND \`stationIncidentsId\` IS NOT NULL`,
      { type: QueryTypes.UPDATE },
    );
    await qi.removeColumn(table, 'stationIncidentsId');
    console.log('✅ backfilled stationId + dropped incidents.stationIncidentsId');
  } else {
    console.log('(skip) incidents.stationIncidentsId already absent');
  }

  // siteId → postSiteId
  if (desc.siteId) {
    await sequelize.query(
      `UPDATE \`${table}\` SET \`postSiteId\` = \`siteId\` ` +
        `WHERE \`postSiteId\` IS NULL AND \`siteId\` IS NOT NULL`,
      { type: QueryTypes.UPDATE },
    );
    await qi.removeColumn(table, 'siteId');
    console.log('✅ backfilled postSiteId + dropped incidents.siteId');
  } else {
    console.log('(skip) incidents.siteId already absent');
  }

  process.exit(0);
}

migrate().catch((err) => {
  console.error(err);
  process.exit(1);
});
