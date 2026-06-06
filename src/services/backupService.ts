/**
 * Backup-pool helpers for the "backup availability" performance bonus.
 *
 * Guards/supervisors earn points for volunteering to cover open shifts and
 * (larger) for actually covering one — awarded when a supervisor confirms it.
 * The `points` column is a snapshot for display; the score recomputes from
 * counts using the tenant's current knobs.
 */

const num = (v: any, d: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

const VOL_PTS = num(process.env.PERF_VOLUNTEER_PTS, 1);
const COVER_PTS = num(process.env.PERF_COVER_PTS, 4);

const todayIso = () => new Date().toISOString().slice(0, 10);

export default class BackupService {
  /** Record a volunteer offer to cover an (open/at-risk) shift. */
  static async volunteer(
    db: any,
    {
      tenantId,
      subjectUserId,
      securityGuardId,
      subjectType,
      shiftId,
      stationId,
      eventDate,
      notes,
      createdById,
    }: {
      tenantId: string;
      subjectUserId: string;
      securityGuardId?: string | null;
      subjectType: 'guard' | 'supervisor';
      shiftId?: string | null;
      stationId?: string | null;
      eventDate?: string | null;
      notes?: string | null;
      createdById?: string | null;
    },
  ) {
    // One standing offer per (subject, shift) — refresh instead of duplicating.
    if (shiftId) {
      const existing = await db.backupEvent.findOne({
        where: {
          tenantId,
          subjectUserId,
          kind: 'volunteer',
          shiftId,
          deletedAt: null,
        },
      });
      if (existing) {
        await existing.update({
          status: 'offered',
          notes: notes ?? existing.notes,
          updatedById: createdById || null,
        });
        return existing.get({ plain: true });
      }
    }

    const ev = await db.backupEvent.create({
      kind: 'volunteer',
      status: 'offered',
      subjectType,
      subjectUserId,
      securityGuardId: securityGuardId || null,
      shiftId: shiftId || null,
      stationId: stationId || null,
      eventDate: eventDate || todayIso(),
      points: VOL_PTS,
      notes: notes || null,
      tenantId,
      createdById: createdById || null,
    });
    return ev.get({ plain: true });
  }

  /**
   * Confirm that a backup event resulted in actual coverage. Promotes the
   * event to kind 'cover' / status 'confirmed' and snapshots the cover points.
   */
  static async confirmCover(
    db: any,
    {
      tenantId,
      eventId,
      confirmedById,
    }: { tenantId: string; eventId: string; confirmedById: string },
  ) {
    const ev = await db.backupEvent.findOne({
      where: { id: eventId, tenantId, deletedAt: null },
    });
    if (!ev) return null;
    await ev.update({
      kind: 'cover',
      status: 'confirmed',
      points: COVER_PTS,
      confirmedById,
      updatedById: confirmedById,
    });
    return ev.get({ plain: true });
  }

  /** Reject / cancel a backup event (no points). */
  static async reject(
    db: any,
    {
      tenantId,
      eventId,
      confirmedById,
    }: { tenantId: string; eventId: string; confirmedById: string },
  ) {
    const ev = await db.backupEvent.findOne({
      where: { id: eventId, tenantId, deletedAt: null },
    });
    if (!ev) return null;
    await ev.update({
      status: 'rejected',
      points: 0,
      confirmedById,
      updatedById: confirmedById,
    });
    return ev.get({ plain: true });
  }
}
