import { Op } from 'sequelize';
import { databaseInit } from '../database/databaseConnection';

/**
 * Syncs the `isOnDuty` field on securityGuards based on active shift times.
 * 
 * Runs periodically (every 5 minutes from server.ts).
 * - If a guard has a shift where NOW is between startTime and endTime → isOnDuty = true
 * - If a guard has no active shift right now → isOnDuty = false
 * 
 * Only updates guards whose status actually changed (to avoid unnecessary writes).
 */
export async function syncGuardDutyStatus() {
  try {
    const database = await databaseInit();
    const now = new Date();

    // Find all guards with an active shift right now
    const [activeGuardRows]: any = await database.sequelize.query(
      `SELECT DISTINCT s.guardId
       FROM shifts s
       WHERE s.deletedAt IS NULL
         AND s.guardId IS NOT NULL
         AND s.startTime <= :now
         AND s.endTime >= :now`,
      { replacements: { now: now.toISOString() } }
    );

    const activeGuardIds = new Set((activeGuardRows || []).map((r: any) => r.guardId));

    // Get all securityGuards
    const allGuards = await database.securityGuard.findAll({
      where: { deletedAt: null },
      attributes: ['id', 'guardId', 'isOnDuty'],
    });

    let onCount = 0;
    let offCount = 0;

    for (const guard of allGuards) {
      const shouldBeOnDuty = activeGuardIds.has(guard.guardId);

      if (shouldBeOnDuty && !guard.isOnDuty) {
        await guard.update({ isOnDuty: true });
        onCount++;
      } else if (!shouldBeOnDuty && guard.isOnDuty) {
        await guard.update({ isOnDuty: false });
        offCount++;
      }
    }

    if (onCount > 0 || offCount > 0) {
      console.log(`[DutySync] Updated: ${onCount} on-duty, ${offCount} off-duty`);
    }
  } catch (err) {
    console.error('[DutySync] Error:', (err as any)?.message || err);
  }
}
