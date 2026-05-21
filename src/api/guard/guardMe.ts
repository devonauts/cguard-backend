/**
 * GET /api/tenant/:tenantId/guard/me
 * 
 * Returns the guard's dashboard: assigned station(s), current shift status,
 * active guardShift (clock-in record), and station schedule.
 */
import ApiResponseHandler from '../apiResponseHandler';
import Error401 from '../../errors/Error401';
import Roles from '../../security/roles';
import { Op } from 'sequelize';

export default async (req: any, res: any) => {
  try {
    const currentUser = req.currentUser;
    if (!currentUser) throw new Error401();

    const db = req.database;
    const userId = currentUser.id;
    const tenantId = req.params.tenantId || (req.currentTenant && req.currentTenant.id);

    // Find the securityGuard record for this user
    const securityGuard = await db.securityGuard.findOne({
      where: { guardId: userId, tenantId, deletedAt: null },
    });

    // Find stations assigned to this guard (via junction table)
    const stations = await db.station.findAll({
      where: { tenantId, deletedAt: null },
      include: [{
        model: db.user,
        as: 'assignedGuards',
        where: { id: userId },
        attributes: [],
        through: { attributes: [] },
      }],
      attributes: [
        'id', 'stationName', 'latitud', 'longitud', 'stationSchedule',
        'startingTimeInDay', 'finishTimeInDay', 'numberOfGuardsInStation',
        'geofenceRadius', 'postSiteId',
      ],
    });

    // Current/upcoming shift for this guard
    const now = new Date();
    const currentShift = await db.shift.findOne({
      where: {
        guardId: userId,
        tenantId,
        startTime: { [Op.lte]: now },
        endTime: { [Op.gte]: now },
      },
      attributes: ['id', 'startTime', 'endTime', 'stationId', 'postSiteId'],
      include: [{ model: db.station, as: 'station', attributes: ['id', 'stationName'] }],
    });

    const nextShift = !currentShift ? await db.shift.findOne({
      where: {
        guardId: userId,
        tenantId,
        startTime: { [Op.gt]: now },
      },
      attributes: ['id', 'startTime', 'endTime', 'stationId', 'postSiteId'],
      include: [{ model: db.station, as: 'station', attributes: ['id', 'stationName'] }],
      order: [['startTime', 'ASC']],
    }) : null;

    // Active clock-in record (guardShift without punchOutTime)
    let activeClockIn: any = null;
    if (securityGuard) {
      const clockIn = await db.guardShift.findOne({
        where: {
          guardNameId: securityGuard.id,
          punchOutTime: null,
          tenantId,
        },
        order: [['punchInTime', 'DESC']],
      });
      if (clockIn) {
        activeClockIn = clockIn.get({ plain: true });
      }
    }

    const response = {
      guard: securityGuard ? {
        id: securityGuard.id,
        fullName: securityGuard.fullName,
        isOnDuty: securityGuard.isOnDuty,
        guardType: securityGuard.guardType,
        guardId: securityGuard.guardId,
      } : null,
      stations: stations.map((s: any) => s.get({ plain: true })),
      currentShift: currentShift ? currentShift.get({ plain: true }) : null,
      nextShift: nextShift ? nextShift.get({ plain: true }) : null,
      activeClockIn,
      isClockedIn: !!activeClockIn,
    };

    return ApiResponseHandler.success(req, res, response);
  } catch (error) {
    return ApiResponseHandler.error(req, res, error);
  }
};
