/**
 * GET /api/tenant/:tenantId/guard/me/backup/open
 * Upcoming shifts (next 14 days) at risk of being missed — i.e. assigned to a
 * guard who has an APPROVED time-off request covering that date. The
 * authenticated guard can volunteer to cover these.
 */
import { Op } from 'sequelize';
import ApiResponseHandler from '../apiResponseHandler';
import Error401 from '../../errors/Error401';

const DAY_MS = 24 * 60 * 60 * 1000;

export default async (req: any, res: any) => {
  try {
    const currentUser = req.currentUser;
    if (!currentUser) throw new Error401();
    const db = req.database;
    const userId = currentUser.id;
    const tenantId =
      req.params.tenantId || (req.currentTenant && req.currentTenant.id);

    const now = new Date();
    const horizon = new Date(now.getTime() + 14 * DAY_MS);

    // Approved time-off overlapping the horizon.
    const timeOff = await db.timeOffRequest.findAll({
      where: {
        tenantId,
        status: { [Op.in]: ['approved', 'Approved', 'aprobado', 'Aprobado'] },
        guardId: { [Op.ne]: userId },
        deletedAt: null,
      },
      attributes: ['guardId', 'startDate', 'endDate'],
    });

    // Map absent guard → covered date ranges.
    const absentByGuard: Record<string, Array<[number, number]>> = {};
    for (const t of timeOff) {
      if (!t.guardId || !t.startDate) continue;
      const sd = new Date(t.startDate).getTime();
      const ed = new Date(t.endDate || t.startDate).getTime();
      (absentByGuard[t.guardId] = absentByGuard[t.guardId] || []).push([sd, ed]);
    }
    const absentGuardIds = Object.keys(absentByGuard);
    if (!absentGuardIds.length) {
      return ApiResponseHandler.success(req, res, { rows: [], count: 0 });
    }

    // Existing volunteer offers by this guard (to flag already-offered shifts).
    const myOffers = await db.backupEvent.findAll({
      where: {
        tenantId,
        subjectUserId: userId,
        kind: 'volunteer',
        status: { [Op.notIn]: ['rejected', 'cancelled'] },
        deletedAt: null,
      },
      attributes: ['shiftId'],
    });
    const offeredShiftIds = new Set(
      myOffers.map((o: any) => o.shiftId).filter(Boolean),
    );

    const shifts = await db.shift.findAll({
      where: {
        tenantId,
        guardId: { [Op.in]: absentGuardIds },
        startTime: { [Op.gte]: now, [Op.lte]: horizon },
        deletedAt: null,
      },
      include: [
        { model: db.user, as: 'guard', attributes: ['id', 'fullName', 'firstName', 'lastName', 'email'] },
        { model: db.station, as: 'station', attributes: ['id', 'stationName'] },
      ],
      order: [['startTime', 'ASC']],
      limit: 100,
    });

    const rows = shifts
      .map((s: any) => s.get({ plain: true }))
      .filter((s: any) => {
        const t = new Date(s.startTime).getTime();
        const ranges = absentByGuard[s.guardId] || [];
        return ranges.some(([sd, ed]) => t >= sd && t <= ed + DAY_MS);
      })
      .map((s: any) => ({
        shiftId: s.id,
        stationId: s.stationId,
        stationName: s.station?.stationName || null,
        startTime: s.startTime,
        endTime: s.endTime,
        absentGuard:
          s.guard?.fullName ||
          [s.guard?.firstName, s.guard?.lastName].filter(Boolean).join(' ') ||
          s.guard?.email ||
          null,
        alreadyOffered: offeredShiftIds.has(s.id),
      }));

    return ApiResponseHandler.success(req, res, { rows, count: rows.length });
  } catch (error) {
    return ApiResponseHandler.error(req, res, error);
  }
};
