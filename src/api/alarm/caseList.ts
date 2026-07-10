/**
 * GET /tenant/:tenantId/alarm/cases?status=
 *
 * List alarm cases for the tenant. Optionally filter by status. Ordered by
 * priority ascending (1 = critical first) then newest created first.
 * Tenant-scoped; requires businessInfoRead.
 */
import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';

export default async (req, res) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.businessInfoRead);

    const db = req.database;
    const tenantId = req.currentTenant.id;

    const { status } = req.query || {};

    const where: any = { tenantId };
    if (status) where.status = status;

    // Limit clamp: the CRM AlarmQueue defaults to "all" (no status) and polls
    // every 20s, so an unbounded list serializes the entire tenant case history
    // per poll. Default 500 rows (priority-first, newest-first — more than any
    // healthy open queue), honor an explicit ?limit up to 1000.
    const requestedLimit = Number((req.query || {}).limit);
    const limit =
      Number.isFinite(requestedLimit) && requestedLimit > 0
        ? Math.min(Math.floor(requestedLimit), 1000)
        : 500;

    // Lean list: explicit columns only (drop the stepProgress JSON blob, which
    // is only rendered in the case detail), and scope the panel include to the
    // two fields the queue renders (name + accountNumber).
    const cases = await db.alarmCase.findAll({
      where,
      attributes: [
        'id',
        'alarmPanelId',
        'status',
        'priority',
        'category',
        'title',
        'assignedOperatorId',
        'ackAt',
        'dispatchAt',
        'resolvedAt',
        'closedAt',
        'disposition',
        'escalatedAt',
        'slaLevel',
        'ecvSatisfied',
        'incidentId',
        'dispatchId',
        'postSiteId',
        'stationId',
        'customerId',
        'source',
        'tenantId',
        'createdById',
        'createdAt',
        'updatedAt',
      ],
      include: [
        {
          model: db.alarmPanel,
          as: 'panel',
          required: false,
          attributes: ['id', 'name', 'accountNumber'],
        },
      ],
      order: [
        ['priority', 'ASC'],
        ['createdAt', 'DESC'],
      ],
      limit,
    });

    await ApiResponseHandler.success(req, res, cases);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
