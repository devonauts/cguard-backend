/**
 * Supervisor forced clock-out — the supervisor mirror of forcedClockOutService,
 * but over `supervisorShift` (NOT guardShift, which is guard-coupled). Closes any
 * open supervisor punch whose scheduled turno ended more than GRACE minutes ago,
 * so a supervisor can't stay "on the clock" indefinitely past their turno.
 *
 * Cluster-safe: the close is a conditional UPDATE keyed on punchOutTime IS NULL,
 * so only one worker wins per shift.
 */
export async function runSupervisorForcedClockOut(db: any): Promise<void> {
  const { Op } = db.Sequelize;
  const now = new Date();
  const graceMin = parseInt(process.env.SUPERVISOR_FORCED_CLOCKOUT_GRACE_MIN || '30', 10);
  const cutoff = new Date(now.getTime() - graceMin * 60_000);

  const stale = await db.supervisorShift.findAll({
    where: {
      punchOutTime: null,
      scheduledEnd: { [Op.ne]: null, [Op.lte]: cutoff },
      deletedAt: null,
    },
    limit: 500,
  });

  for (const s of stale) {
    const [claimed] = await db.supervisorShift.update(
      {
        punchOutTime: now,
        forcedClockOut: true,
        observations: s.observations
          ? `${s.observations}\n[Cierre automático al fin del turno]`
          : 'Cierre automático al fin del turno',
      },
      { where: { id: s.id, punchOutTime: null } },
    );
    if (!claimed) continue;

    // Clear the denormalized on-duty flag on the profile.
    try {
      await db.supervisorProfile.update(
        { isOnDuty: false },
        { where: { tenantId: s.tenantId, supervisorUserId: s.supervisorUserId } },
      );
    } catch { /* non-fatal */ }

    // Notify the CRM (bell/feed), best-effort.
    try {
      const { storePlatformEvent } = require('../lib/platformEventStore');
      await storePlatformEvent(db, {
        tenantId: s.tenantId,
        eventType: 'supervisor.forced_checkout',
        title: 'Supervisor: cierre automático de turno',
        body: '',
        targetRoles: 'admin,operationsManager',
        sourceEntityType: 'supervisorShift',
        sourceEntityId: s.id,
        payload: { supervisorUserId: s.supervisorUserId },
      });
    } catch { /* non-fatal */ }
  }
}

export default { runSupervisorForcedClockOut };
