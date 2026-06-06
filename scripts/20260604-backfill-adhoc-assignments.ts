/**
 * Phase B (backfill): convert "orphan" shifts (raw shifts created by the old
 * post-site / guard-profile screens, with guardAssignmentId IS NULL) into
 * ad-hoc `guardAssignment` rows, then point those shifts at the new assignment.
 *
 * After this, EVERY shift has a parent guardAssignment — the single source of
 * truth — so assignments are consistent across Horario, the guard app, coverage
 * and post-site views.
 *
 * Idempotent: only touches shifts whose guardAssignmentId IS NULL.
 * Run AFTER 20260604-add-adhoc-to-guard-assignments.ts.
 * Run: npx ts-node scripts/20260604-backfill-adhoc-assignments.ts
 */
require('dotenv').config();

import models from '../src/database/models';
import { QueryTypes } from 'sequelize';
import { randomUUID } from 'crypto';

async function run() {
  const { sequelize } = models();

  // ── Audit ────────────────────────────────────────────────────────────────
  const [orphan]: any = await sequelize.query(
    `SELECT COUNT(*) c FROM shifts WHERE guardAssignmentId IS NULL AND deletedAt IS NULL
       AND guardId IS NOT NULL AND stationId IS NOT NULL`,
    { type: QueryTypes.SELECT },
  );
  const [pivot]: any = await sequelize.query(
    `SELECT COUNT(*) c FROM tenant_user_post_sites`,
    { type: QueryTypes.SELECT },
  ).catch(() => [{ c: 'n/a' }]);
  const [junction]: any = await sequelize.query(
    `SELECT COUNT(*) c FROM stationAssignedGuardsUser`,
    { type: QueryTypes.SELECT },
  ).catch(() => [{ c: 'n/a' }]);

  console.log(`AUDIT  orphan shifts (no assignment): ${orphan.c}`);
  console.log(`AUDIT  tenant_user_post_sites rows:   ${pivot.c}`);
  console.log(`AUDIT  stationAssignedGuardsUser rows: ${junction.c}`);

  // ── Backfill ───────────────────────────────────────────────────────────────
  // Group orphan shifts by (tenantId, guardId, stationId): one ad-hoc assignment
  // per group, spanning the group's date range, with the earliest shift's window.
  const groups: any[] = await sequelize.query(
    `SELECT tenantId, guardId, stationId,
            MIN(DATE(startTime)) startDate,
            MAX(DATE(startTime)) endDate,
            MIN(postSiteId)      postSiteId,
            MIN(createdById)     createdById
       FROM shifts
      WHERE guardAssignmentId IS NULL AND deletedAt IS NULL
        AND guardId IS NOT NULL AND stationId IS NOT NULL
      GROUP BY tenantId, guardId, stationId`,
    { type: QueryTypes.SELECT },
  );

  console.log(`Backfilling ${groups.length} (tenant,guard,station) groups...`);
  let created = 0;
  let linked = 0;

  for (const g of groups) {
    const t = await sequelize.transaction();
    try {
      // earliest shift in the group → HH:mm window
      const [first]: any = await sequelize.query(
        `SELECT startTime, endTime FROM shifts
          WHERE guardAssignmentId IS NULL AND deletedAt IS NULL
            AND tenantId = :tenantId AND guardId = :guardId AND stationId = :stationId
          ORDER BY startTime ASC LIMIT 1`,
        { replacements: g, type: QueryTypes.SELECT, transaction: t },
      );
      const hhmm = (d: any) => {
        if (!d) return null;
        const dt = new Date(d);
        const p = (n: number) => String(n).padStart(2, '0');
        return `${p(dt.getHours())}:${p(dt.getMinutes())}`;
      };

      const id = randomUUID();
      await sequelize.query(
        `INSERT INTO guardAssignments
           (id, guardId, stationId, kind, positionId, rotationStyleId, startDate, endDate,
            startTime, endTime, platoonOffset, isRelief, status, tenantId,
            createdById, updatedById, createdAt, updatedAt)
         VALUES
           (:id, :guardId, :stationId, 'adhoc', NULL, NULL, :startDate, :endDate,
            :startTime, :endTime, 0, 0, 'active', :tenantId,
            :createdById, :createdById, NOW(), NOW())`,
        {
          replacements: {
            id,
            guardId: g.guardId,
            stationId: g.stationId,
            startDate: g.startDate,
            endDate: g.endDate,
            startTime: hhmm(first?.startTime),
            endTime: hhmm(first?.endTime),
            tenantId: g.tenantId,
            createdById: g.createdById || null,
          },
          transaction: t,
        },
      );
      created++;

      const [res]: any = await sequelize.query(
        `UPDATE shifts SET guardAssignmentId = :id
          WHERE guardAssignmentId IS NULL AND deletedAt IS NULL
            AND tenantId = :tenantId AND guardId = :guardId AND stationId = :stationId`,
        { replacements: { id, ...g }, transaction: t },
      );
      linked += (res?.affectedRows ?? res?.[1] ?? 0) || 0;

      await t.commit();
    } catch (e: any) {
      await t.rollback();
      console.error(`  ✗ group ${g.guardId}/${g.stationId} failed:`, e?.message || e);
    }
  }

  console.log(`✅ created ${created} ad-hoc assignments, linked shifts for ${linked} rows.`);
  process.exit(0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
