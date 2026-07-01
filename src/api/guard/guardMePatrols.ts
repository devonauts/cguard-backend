/**
 * GET /api/tenant/:tenantId/guard/me/patrols
 *
 * Patrol history for the authenticated guard (their tour assignments with
 * route name, status, timestamps and scan count). Drives the worker-app
 * patrol history.
 */
import { Op } from 'sequelize';
import ApiResponseHandler from '../apiResponseHandler';
import Error401 from '../../errors/Error401';

export default async (req: any, res: any) => {
  try {
    const currentUser = req.currentUser;
    if (!currentUser) throw new Error401();
    const db = req.database;
    const userId = currentUser.id;
    const tenantId =
      req.params.tenantId || (req.currentTenant && req.currentTenant.id);

    const securityGuard = await db.securityGuard.findOne({
      where: { guardId: userId, tenantId, deletedAt: null },
      attributes: ['id'],
    });
    if (!securityGuard) {
      return ApiResponseHandler.success(req, res, { rows: [], count: 0 });
    }

    // The worker only shows the CURRENT SHIFT DAY: patrols since the guard's open
    // clock-in, or since local midnight if not clocked in. (The CRM / client /
    // supervisor keep the full history — this cap is worker-only by design.)
    let since: Date;
    const openShift = await db.guardShift.findOne({
      where: { guardNameId: securityGuard.id, tenantId, punchOutTime: null },
      order: [['punchInTime', 'DESC']],
      attributes: ['punchInTime'],
    });
    if (openShift && openShift.punchInTime) {
      since = new Date(openShift.punchInTime);
    } else {
      since = new Date();
      since.setHours(0, 0, 0, 0);
    }

    const assignments = await db.tourAssignment.findAll({
      where: {
        securityGuardId: securityGuard.id,
        tenantId,
        [Op.or]: [
          { startAt: { [Op.gte]: since } },
          { startAt: null, createdAt: { [Op.gte]: since } },
        ],
      },
      order: [['updatedAt', 'DESC']],
      limit: 50,
    });

    const rows: any[] = [];
    for (const a of assignments) {
      const plain = a.get({ plain: true });
      let routeName: string | null = null;
      try {
        const tour = await db.siteTour.findByPk(plain.siteTourId);
        routeName = tour ? tour.name : null;
      } catch {
        /* ignore */
      }
      let scanCount = 0;
      try {
        scanCount = await db.tagScan.count({ where: { tourAssignmentId: plain.id } });
      } catch {
        /* ignore */
      }
      rows.push({
        id: plain.id,
        siteTourId: plain.siteTourId,
        routeName,
        status: plain.status,
        startAt: plain.startAt,
        endAt: plain.endAt,
        updatedAt: plain.updatedAt,
        scanCount,
      });
    }

    return ApiResponseHandler.success(req, res, { rows, count: rows.length });
  } catch (error) {
    return ApiResponseHandler.error(req, res, error);
  }
};
