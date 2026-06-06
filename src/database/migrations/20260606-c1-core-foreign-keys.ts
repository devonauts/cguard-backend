/**
 * C1 — enforce referential integrity at the DB on the core operational chain
 * (clientAccount → businessInfo → station → shift/guardAssignment → guardShift,
 * plus securityGuard/shift/guardAssignment → user). Previously every association
 * used `constraints: false`, so the DB enforced nothing and bad references were
 * silently dropped (see the comment in models/shift.ts about unlinked shifts).
 *
 * onDelete rules:
 *  - RESTRICT on required hierarchy links (user/station/securityGuard) — these
 *    entities are SOFT-deleted (paranoid), so RESTRICT only ever fires on a rare
 *    hard delete, where we WANT it to fail loudly instead of orphaning rows.
 *  - SET NULL on optional links (postSiteId, clientAccountId, shift.stationId/
 *    guardAssignmentId/positionId) — a hard delete of the parent nulls the ref.
 *
 * Note: guardAssignments.guardId/stationId use RESTRICT/RESTRICT (not SET NULL/
 * CASCADE) because they are base columns of the STORED generated column
 * `activeSlotKey` (the C13 unique), and MySQL forbids cascading actions on those.
 * guardAssignments.positionId is intentionally left WITHOUT an FK: it's a base
 * column of activeSlotKey (so SET NULL is forbidden) AND the position-rebuild
 * flow force-deletes positions, which a RESTRICT would block.
 *
 * Idempotent. Run: npx ts-node src/database/migrations/20260606-c1-core-foreign-keys.ts
 */
require('dotenv').config();

import models from '../models';

const FKS: Array<{ name: string; table: string; column: string; ref: string; onDelete: string; onUpdate?: string }> = [
  { name: 'fk_businessInfos_clientAccount', table: 'businessInfos', column: 'clientAccountId', ref: 'clientAccounts', onDelete: 'SET NULL' },
  { name: 'fk_stations_postSite', table: 'stations', column: 'postSiteId', ref: 'businessInfos', onDelete: 'SET NULL' },
  { name: 'fk_securityGuards_user', table: 'securityGuards', column: 'guardId', ref: 'users', onDelete: 'RESTRICT' },
  { name: 'fk_guardAssignments_user', table: 'guardAssignments', column: 'guardId', ref: 'users', onDelete: 'RESTRICT', onUpdate: 'RESTRICT' },
  { name: 'fk_guardAssignments_station', table: 'guardAssignments', column: 'stationId', ref: 'stations', onDelete: 'RESTRICT', onUpdate: 'RESTRICT' },
  { name: 'fk_shifts_station', table: 'shifts', column: 'stationId', ref: 'stations', onDelete: 'SET NULL' },
  { name: 'fk_shifts_user', table: 'shifts', column: 'guardId', ref: 'users', onDelete: 'RESTRICT' },
  { name: 'fk_shifts_assignment', table: 'shifts', column: 'guardAssignmentId', ref: 'guardAssignments', onDelete: 'SET NULL' },
  { name: 'fk_shifts_position', table: 'shifts', column: 'positionId', ref: 'stationPositions', onDelete: 'SET NULL' },
  { name: 'fk_guardShifts_securityGuard', table: 'guardShifts', column: 'guardNameId', ref: 'securityGuards', onDelete: 'RESTRICT' },
];

async function migrate() {
  const { sequelize } = models();
  for (const fk of FKS) {
    const [rows]: any = await sequelize.query(
      `SELECT 1 FROM information_schema.referential_constraints
        WHERE constraint_schema = DATABASE() AND constraint_name = ?`,
      { replacements: [fk.name] },
    );
    if ((rows as any[]).length) {
      console.log(`• ${fk.name} already exists, skipping`);
      continue;
    }
    try {
      await sequelize.query(
        `ALTER TABLE \`${fk.table}\` ADD CONSTRAINT \`${fk.name}\`
           FOREIGN KEY (\`${fk.column}\`) REFERENCES \`${fk.ref}\`(id)
           ON DELETE ${fk.onDelete} ON UPDATE ${fk.onUpdate || 'CASCADE'}`,
      );
      console.log(`✅ ${fk.name}`);
    } catch (e: any) {
      console.error(`✗ ${fk.name}: ${e?.message || e}`);
    }
  }
  process.exit(0);
}

migrate().catch((err) => {
  console.error(err);
  process.exit(1);
});
