/**
 * GET /api/tenant/:tenantId/guard/me/orders
 * Today's due "consignas específicas" for the authenticated guard's station(s),
 * each with its completion status for today. Drives the worker-app Consignas list.
 */
import ApiResponseHandler from '../apiResponseHandler';
import Error401 from '../../errors/Error401';
import { isDueOn, ymd, dueAt } from '../../services/consignaRecurrence';

export default async (req: any, res: any) => {
  try {
    const currentUser = req.currentUser;
    if (!currentUser) throw new Error401();
    const db = req.database;
    const userId = currentUser.id;
    const tenantId = req.params.tenantId || (req.currentTenant && req.currentTenant.id);

    const securityGuard = await db.securityGuard.findOne({
      where: { guardId: userId, tenantId, deletedAt: null },
      attributes: ['id'],
    });

    // stations the guard is assigned to
    const stations = await db.station.findAll({
      where: { tenantId, deletedAt: null },
      attributes: ['id', 'stationName'],
      include: [{ model: db.user, as: 'assignedGuards', where: { id: userId }, attributes: [], through: { attributes: [] }, required: true }],
    });
    const stationIds = stations.map((s: any) => s.id);
    const stationName: Record<string, string> = {};
    stations.forEach((s: any) => { stationName[s.id] = s.stationName; });
    if (!stationIds.length) return ApiResponseHandler.success(req, res, { rows: [], count: 0 });

    // consigna times are interpreted in the tenant's timezone
    const tenant = await db.tenant.findByPk(tenantId, { attributes: ['timezone'] });
    const tz = tenant?.timezone || 'UTC';
    const today = new Date();
    const occ = ymd(today, tz);

    const orders = await db.stationOrder.findAll({
      where: { tenantId, stationId: stationIds, active: true, deletedAt: null },
      order: [['time', 'ASC']],
    });

    const due = orders.map((o: any) => o.get({ plain: true })).filter((o: any) => isDueOn(o, today, tz));

    // completions for today
    const completions = await db.stationOrderCompletion.findAll({
      where: { tenantId, occurrenceDate: occ, stationOrderId: due.map((o: any) => o.id).concat(['__none__']) },
    });
    const doneByOrder: Record<string, any> = {};
    completions.forEach((c: any) => { doneByOrder[c.stationOrderId] = c.get({ plain: true }); });

    const rows = due.map((o: any) => ({
      id: o.id,
      title: o.title,
      description: o.description,
      time: o.time,
      priority: o.priority,
      recurrence: o.recurrence,
      stationId: o.stationId,
      stationName: stationName[o.stationId] || null,
      dueAt: dueAt(o, today, tz).toISOString(),
      occurrenceDate: occ,
      done: !!doneByOrder[o.id],
      completion: doneByOrder[o.id] || null,
    }));

    return ApiResponseHandler.success(req, res, { rows, count: rows.length });
  } catch (error) {
    return ApiResponseHandler.error(req, res, error);
  }
};
