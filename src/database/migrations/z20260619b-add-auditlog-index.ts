require('dotenv').config();

import models from '../models';
import { QueryInterface } from 'sequelize';

/**
 * auditLogs is a high-write table with NO indexes and is read by (tenantId, time)
 * for the audit feed — unindexed scans get slow as it grows. Add a composite
 * index on (tenantId, timestamp). Idempotent: skips if the index already exists.
 * NB: the time column is `timestamp` (the model sets timestamps:false, so there
 * is no createdAt).
 */
async function migrate() {
  const { sequelize } = models();
  const qi: QueryInterface = sequelize.getQueryInterface();
  const TABLE = 'auditLogs';
  const INDEX = 'audit_log_tenant_timestamp';

  try {
    const [[tbl]]: any = await sequelize.query(
      `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = '${TABLE}' AND TABLE_SCHEMA = DATABASE()`,
    );
    if (!tbl) {
      console.log(`Table ${TABLE} not found. Skipping.`);
      process.exit(0);
    }
    const [[idx]]: any = await sequelize.query(
      `SELECT INDEX_NAME FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_NAME = '${TABLE}' AND INDEX_NAME = '${INDEX}' AND TABLE_SCHEMA = DATABASE() LIMIT 1`,
    );
    if (idx) {
      console.log(`Index ${INDEX} already exists. Skipping.`);
      process.exit(0);
    }

    console.log(`Adding index ${INDEX} on ${TABLE}(tenantId, timestamp)...`);
    await qi.addIndex(TABLE, ['tenantId', 'timestamp'], { name: INDEX });
    console.log('✅ audit-log index created.');
    process.exit(0);
  } catch (error) {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  }
}

export { migrate };

migrate();
