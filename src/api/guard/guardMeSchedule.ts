/**
 * GET /api/tenant/:tenantId/guard/me/schedule
 * 
 * Returns the guard's upcoming shifts and free days (approved time-off).
 */
import ApiResponseHandler from '../apiResponseHandler';
import Error401 from '../../errors/Error401';
import { Op } from 'sequelize';

export default async (req: any, res: any) => {
  try {
    const currentUser = req.currentUser;
    if (!currentUser) throw new Error401();

    const db = req.database;
    const userId = currentUser.id;
    const tenantId = req.params.tenantId || (req.currentTenant && req.currentTenant.id);

    // Shifts for the next 30 days
    const now = new Date();
    const thirtyDaysAhead = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

    const shifts = await db.shift.findAll({
      where: {
        guardId: userId,
        tenantId,
        startTime: { [Op.lte]: thirtyDaysAhead },
        endTime: { [Op.gte]: now },
      },
      attributes: ['id', 'startTime', 'endTime', 'stationId', 'postSiteId'],
      include: [
        { model: db.station, as: 'station', attributes: ['id', 'stationName'] },
      ],
      order: [['startTime', 'ASC']],
      limit: 100,
    });

    // Approved time-off (free days)
    const securityGuard = await db.securityGuard.findOne({
      where: { guardId: userId, tenantId, deletedAt: null },
      attributes: ['id'],
    });

    let timeOff: any[] = [];
    if (securityGuard) {
      const rows = await db.timeOffRequest.findAll({
        where: {
          guardId: securityGuard.id,
          tenantId,
          status: 'approved',
          endDate: { [Op.gte]: now },
        },
        attributes: ['id', 'startDate', 'endDate', 'type', 'reason', 'status'],
        order: [['startDate', 'ASC']],
        limit: 50,
      });
      timeOff = rows.map((r: any) => r.get({ plain: true }));
    }

    // Build free-day set from approved time-off ranges
    const freeDays: string[] = [];
    for (const to of timeOff) {
      const start = new Date(to.startDate);
      const end = new Date(to.endDate);
      const cursor = new Date(start);
      while (cursor <= end && freeDays.length < 365) {
        freeDays.push(cursor.toISOString().slice(0, 10));
        cursor.setDate(cursor.getDate() + 1);
      }
    }

    return ApiResponseHandler.success(req, res, {
      shifts: shifts.map((s: any) => s.get({ plain: true })),
      timeOff,
      freeDays: [...new Set(freeDays)],
    });
  } catch (error) {
    return ApiResponseHandler.error(req, res, error);
  }
};
