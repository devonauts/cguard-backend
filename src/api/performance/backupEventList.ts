/**
 * GET /api/tenant/:tenantId/backup-event?status=offered
 * Backup events for supervisors to review/confirm. Optional ?status filter.
 */
import { Op } from 'sequelize';
import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';

export default async (req: any, res: any) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.backupConfirm);
    const db = req.database;
    const tenantId =
      req.params.tenantId || (req.currentTenant && req.currentTenant.id);

    const where: any = { tenantId, deletedAt: null };
    if (req.query.status) {
      const statuses = String(req.query.status).split(',');
      where.status = { [Op.in]: statuses };
    }

    const rows = await db.backupEvent.findAll({
      where,
      include: [
        { model: db.user, as: 'subject', attributes: ['id', 'fullName', 'firstName', 'lastName', 'email'] },
        { model: db.station, as: 'station', attributes: ['id', 'stationName'] },
        { model: db.shift, as: 'shift', attributes: ['id', 'startTime', 'endTime'] },
      ],
      order: [['eventDate', 'DESC']],
      limit: 200,
    });

    return ApiResponseHandler.success(req, res, {
      rows: rows.map((r: any) => r.get({ plain: true })),
      count: rows.length,
    });
  } catch (error) {
    return ApiResponseHandler.error(req, res, error);
  }
};
