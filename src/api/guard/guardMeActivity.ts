/**
 * GET /api/tenant/:tenantId/guard/me/activity
 *
 * Recent site activity for the on-duty home screen — the last platform events
 * for the tenant (supervisor check-ins, visitor arrivals, patrols, incidents).
 * Returns a normalized, UI-ready list.
 */
import ApiResponseHandler from '../apiResponseHandler';
import Error401 from '../../errors/Error401';

export default async (req: any, res: any) => {
  try {
    const currentUser = req.currentUser;
    if (!currentUser) throw new Error401();
    const db = req.database;
    const tenantId = req.params.tenantId || (req.currentTenant && req.currentTenant.id);
    const limit = Math.min(Number(req.query.limit) || 8, 20);

    const [rows] = await db.sequelize.query(
      `SELECT id, eventType, title, body, createdAt
         FROM platform_events
        WHERE tenantId = ?
        ORDER BY createdAt DESC
        LIMIT ?`,
      { replacements: [tenantId, limit] },
    );

    const items = (rows as any[]).map((r) => ({
      id: r.id,
      eventType: r.eventType,
      title: r.title,
      subtitle: r.body || null,
      at: r.createdAt,
    }));

    return ApiResponseHandler.success(req, res, { rows: items });
  } catch (error) {
    return ApiResponseHandler.error(req, res, error);
  }
};
