/**
 * Uniform-inspection helpers for the "correctly uniformed" performance factor.
 * A supervisor rates how correctly a guard/supervisor is uniformed (0..100).
 */

const clamp = (n: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, n));

export default class UniformInspectionService {
  /**
   * Create a uniform inspection for a subject (guard or supervisor user).
   * Resolves the subject's securityGuard record when present.
   */
  static async create(
    db: any,
    {
      tenantId,
      subjectUserId,
      inspectorId,
      rating,
      stars,
      notes,
      photos,
      stationId,
      inspectionDate,
    }: {
      tenantId: string;
      subjectUserId: string;
      inspectorId: string;
      rating: number;
      stars?: number | null;
      notes?: string | null;
      photos?: any[] | null;
      stationId?: string | null;
      inspectionDate?: Date | string | null;
    },
  ) {
    const securityGuard = await db.securityGuard.findOne({
      where: { guardId: subjectUserId, tenantId, deletedAt: null },
      attributes: ['id'],
    });

    const ev = await db.uniformInspection.create({
      subjectType: securityGuard ? 'guard' : 'supervisor',
      subjectUserId,
      securityGuardId: securityGuard?.id || null,
      inspectorId,
      rating: Math.round(clamp(Number(rating) || 0, 0, 100)),
      stars: stars != null ? Math.round(clamp(Number(stars), 0, 5)) : null,
      notes: notes || null,
      photos: Array.isArray(photos) ? photos : [],
      stationId: stationId || null,
      inspectionDate: inspectionDate ? new Date(inspectionDate) : new Date(),
      tenantId,
      createdById: inspectorId,
    });
    return ev.get({ plain: true });
  }

  /** List inspections for a subject user, most recent first. */
  static async listForSubject(
    db: any,
    tenantId: string,
    subjectUserId: string,
    limit = 50,
  ) {
    const rows = await db.uniformInspection.findAll({
      where: { tenantId, subjectUserId, deletedAt: null },
      order: [['inspectionDate', 'DESC']],
      limit,
    });
    return rows.map((r: any) => r.get({ plain: true }));
  }
}
