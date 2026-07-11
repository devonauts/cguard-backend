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

    // Set-based reconcile: two UPDATEs that touch ONLY mismatched rows, instead
    // of loading every securityGuard platform-wide and updating one row at a
    // time. guardShift.guardNameId references securityGuard.id; an open
    // guardShift (punchOutTime IS NULL) means "on duty". updatedAt is bumped to
    // match what the previous per-row guard.update() did.
    const [onRes]: any = await database.sequelize.query(
      `UPDATE securityGuards sg
          SET sg.isOnDuty = true, sg.updatedAt = NOW()
        WHERE sg.deletedAt IS NULL
          AND sg.isOnDuty = false
          AND EXISTS (
                SELECT 1 FROM guardShifts gs
                 WHERE gs.guardNameId = sg.id
                   AND gs.deletedAt IS NULL
                   AND gs.punchOutTime IS NULL
              )`,
    );
    const [offRes]: any = await database.sequelize.query(
      `UPDATE securityGuards sg
          SET sg.isOnDuty = false, sg.updatedAt = NOW()
        WHERE sg.deletedAt IS NULL
          AND sg.isOnDuty = true
          AND NOT EXISTS (
                SELECT 1 FROM guardShifts gs
                 WHERE gs.guardNameId = sg.id
                   AND gs.deletedAt IS NULL
                   AND gs.punchOutTime IS NULL
              )`,
    );
    const onCount = Number(onRes?.affectedRows ?? onRes?.rowCount ?? 0);
    const offCount = Number(offRes?.affectedRows ?? offRes?.rowCount ?? 0);

    if (onCount > 0 || offCount > 0) {
      console.log(`[DutySync] Reconciled cache: ${onCount} on-duty, ${offCount} off-duty`);
    }
  } catch (err) {
    console.error('[DutySync] Error:', (err as any)?.message || err);
  }
}
