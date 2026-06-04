/**
 * POST /api/tenant/:tenantId/guard/me/orders/:id/complete
 * Mark today's occurrence of a consigna complete, with evidence:
 *   body.data = { note?, photos?[], videoUrl?, audioUrl?, occurrenceDate? }
 * Upserts one completion per (order, occurrence day). Also stores a platform
 * event so the activity feed / supervisors see it.
 */
import ApiResponseHandler from '../apiResponseHandler';
import Error401 from '../../errors/Error401';
import Error400 from '../../errors/Error400';
import { ymd } from '../../services/consignaRecurrence';

export default async (req: any, res: any) => {
  try {
    const currentUser = req.currentUser;
    if (!currentUser) throw new Error401();
    const db = req.database;
    const userId = currentUser.id;
    const tenantId = req.params.tenantId || (req.currentTenant && req.currentTenant.id);
    const orderId = req.params.id;
    const data = (req.body && req.body.data) || req.body || {};

    const order = await db.stationOrder.findOne({ where: { id: orderId, tenantId, deletedAt: null } });
    if (!order) throw new Error400(req.language, 'guard.orderNotFound');

    // guard must be assigned to the order's station
    const assigned = await db.station.findOne({
      where: { id: order.stationId, tenantId, deletedAt: null },
      include: [{ model: db.user, as: 'assignedGuards', where: { id: userId }, attributes: ['id'], through: { attributes: [] }, required: true }],
    });
    if (!assigned) throw new Error400(req.language, 'guard.notAssignedToStation');

    const securityGuard = await db.securityGuard.findOne({ where: { guardId: userId, tenantId, deletedAt: null } });
    const occ = data.occurrenceDate || ymd(new Date());

    const payload = {
      note: data.note || null,
      photos: Array.isArray(data.photos) ? data.photos : [],
      videoUrl: data.videoUrl || null,
      audioUrl: data.audioUrl || null,
      completedAt: new Date(),
      guardName: securityGuard?.fullName || currentUser.fullName || currentUser.email || null,
    };

    let completion = await db.stationOrderCompletion.findOne({
      where: { tenantId, stationOrderId: orderId, occurrenceDate: occ },
    });
    if (completion) {
      await completion.update({ ...payload, createdById: userId });
    } else {
      completion = await db.stationOrderCompletion.create({
        ...payload,
        occurrenceDate: occ,
        stationOrderId: orderId,
        stationId: order.stationId,
        securityGuardId: securityGuard?.id || null,
        tenantId,
        createdById: userId,
      });
    }

    // activity event + push to tenant (best-effort, never blocks)
    try {
      const { pushToTenant } = require('../../services/pushService');
      await pushToTenant(db, tenantId, {
        title: 'Consigna completada',
        body: `${payload.guardName || 'Un guardia'} completó: ${order.title}`,
        data: { type: 'consigna.completed', orderId, stationId: order.stationId },
      });
    } catch { /* ignore */ }

    return ApiResponseHandler.success(req, res, completion.get({ plain: true }));
  } catch (error) {
    return ApiResponseHandler.error(req, res, error);
  }
};
