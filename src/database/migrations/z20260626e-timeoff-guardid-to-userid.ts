require('dotenv').config();

import models from '../models';

/**
 * Normalize timeOffRequest.guardId to the USER id.
 *
 * The worker app used to write securityGuard.id into guardId while the CRM (and
 * the model FK → user, and shift.guardId) use the user id. That split made
 * worker-created requests show "—" in the CRM and broke the backup/volunteer
 * pool. The code now writes the user id everywhere; this backfills the existing
 * rows that hold a securityGuard.id, mapping each to its owning user id.
 * Rows already keyed by user id don't match a securityGuard.id and are untouched.
 */
async function migrate() {
  const { sequelize } = models();
  try {
    const [result]: any = await sequelize.query(`
      UPDATE timeOffRequests t
      JOIN securityGuards sg ON sg.id = t.guardId AND sg.tenantId = t.tenantId
      SET t.guardId = sg.guardId
      WHERE sg.guardId IS NOT NULL
    `);
    const affected = (result && (result.affectedRows ?? result.changedRows)) ?? 'n/a';
    console.log(`✅ timeOffRequests.guardId normalized to user id (rows touched: ${affected})`);
    process.exit(0);
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  }
}

export { migrate };

migrate();
