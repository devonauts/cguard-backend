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

    // Lean list: explicit columns only (drop the stepProgress JSON blob, which
    // is only rendered in the case detail), and scope the panel include to the
    // two fields the queue renders (name + accountNumber). No limit clamp — the
    // queue must show every open case for the chosen status.
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
    });

    await ApiResponseHandler.success(req, res, cases);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
