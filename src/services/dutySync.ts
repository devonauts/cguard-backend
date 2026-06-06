import { databaseInit } from '../database/databaseConnection';

/**
 * Reconciles the denormalized `securityGuard.isOnDuty` cache against the SINGLE
 * SOURCE OF TRUTH: an open `guardShift` (a clock-in with no punch-out).
 *
 * Runs periodically (every 5 minutes from server.ts) as a SAFETY NET only —
 * clock-in/clock-out are the authoritative writers and update the flag instantly
 * inside their own handlers; this catches the rare case where one of those
 * half-completes (crash/network) and leaves the flag stale.
 *
 * IMPORTANT: "on duty" means the guard is ACTUALLY CLOCKED IN, not merely
 * scheduled. The previous version derived it from the shift schedule window,
 * which fought clock-out — a guard who clocked out early but was still inside
 * their scheduled window got flipped back on-duty every 5 minutes.
 */
export async function syncGuardDutyStatus() {
  try {
    const database = await databaseInit();

    // securityGuards that currently have an OPEN guardShift (punchOutTime IS NULL).
    // guardShift.guardNameId references securityGuard.id.
    const [openRows]: any = await database.sequelize.query(
      `SELECT DISTINCT gs.guardNameId AS sgId
         FROM guardShifts gs
        WHERE gs.deletedAt IS NULL
          AND gs.punchOutTime IS NULL
          AND gs.guardNameId IS NOT NULL`,
    );
    const onDutyIds = new Set((openRows || []).map((r: any) => r.sgId));

    const allGuards = await database.securityGuard.findAll({
      where: { deletedAt: null },
      attributes: ['id', 'isOnDuty'],
    });

    let onCount = 0;
    let offCount = 0;
    for (const guard of allGuards) {
      const shouldBeOnDuty = onDutyIds.has(guard.id);
      if (shouldBeOnDuty && !guard.isOnDuty) {
        await guard.update({ isOnDuty: true });
        onCount++;
      } else if (!shouldBeOnDuty && guard.isOnDuty) {
        await guard.update({ isOnDuty: false });
        offCount++;
      }
    }

    if (onCount > 0 || offCount > 0) {
      console.log(`[DutySync] Reconciled cache: ${onCount} on-duty, ${offCount} off-duty`);
    }
  } catch (err) {
    console.error('[DutySync] Error:', (err as any)?.message || err);
  }
}
