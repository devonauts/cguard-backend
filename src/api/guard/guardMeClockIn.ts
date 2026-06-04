/**
 * POST /api/tenant/:tenantId/guard/me/clock-in
 * 
 * Guard clocks in. Validates GPS against station geofence.
 * Body: { stationId, latitude, longitude, shiftSchedule?, observations? }
 */
import ApiResponseHandler from '../apiResponseHandler';
import Error400 from '../../errors/Error400';
import Error401 from '../../errors/Error401';

/** Haversine distance in meters between two coordinates */
function haversineDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000; // Earth radius in meters
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

export default async (req: any, res: any) => {
  try {
    const currentUser = req.currentUser;
    if (!currentUser) throw new Error401();

    const db = req.database;
    const userId = currentUser.id;
    const tenantId = req.params.tenantId || (req.currentTenant && req.currentTenant.id);

    const { stationId, latitude, longitude, shiftSchedule, observations,
      selfiePhoto, address, battery, checklist } = req.body.data || req.body;

    if (!stationId) throw new Error400(req.language, 'guard.stationRequired');
    if (latitude == null || longitude == null) throw new Error400(req.language, 'guard.locationRequired');

    // Validate station exists and guard is assigned
    const station = await db.station.findOne({
      where: { id: stationId, tenantId, deletedAt: null },
      include: [{
        model: db.user,
        as: 'assignedGuards',
        where: { id: userId },
        attributes: ['id'],
        through: { attributes: [] },
        required: true,
      }],
    });

    if (!station) {
      throw new Error400(req.language, 'guard.notAssignedToStation');
    }

    // Geofence validation
    const stationLat = parseFloat(station.latitud);
    const stationLng = parseFloat(station.longitud);
    const radius = station.geofenceRadius || 100; // default 100 meters

    if (!isNaN(stationLat) && !isNaN(stationLng)) {
      const distance = haversineDistance(
        Number(latitude), Number(longitude),
        stationLat, stationLng
      );
      if (distance > radius) {
        return ApiResponseHandler.success(req, res, {
          success: false,
          error: 'geofence_failed',
          message: `Estás a ${Math.round(distance)}m del puesto. Máximo permitido: ${radius}m.`,
          distance: Math.round(distance),
          maxRadius: radius,
        });
      }
    }

    // Find securityGuard record
    const securityGuard = await db.securityGuard.findOne({
      where: { guardId: userId, tenantId, deletedAt: null },
    });

    if (!securityGuard) {
      throw new Error400(req.language, 'guard.profileNotFound');
    }

    // Check if already clocked in
    const existingClock = await db.guardShift.findOne({
      where: { guardNameId: securityGuard.id, punchOutTime: null, tenantId },
    });

    if (existingClock) {
      return ApiResponseHandler.success(req, res, {
        success: false,
        error: 'already_clocked_in',
        message: 'Ya tienes un registro de entrada activo.',
        activeClockIn: existingClock.get({ plain: true }),
      });
    }

    // Create guardShift (clock-in record)
    const guardShiftRecord = await db.guardShift.create({
      punchInTime: new Date(),
      punchInLatitude: Number(latitude),
      punchInLongitude: Number(longitude),
      shiftSchedule: shiftSchedule || 'Diurno',
      numberOfPatrolsDuringShift: 0,
      numberOfIncidentsDurindShift: 0,
      observations: observations || 'Entrada registrada',
      punchInPhoto: selfiePhoto || null,
      punchInAddress: address ? String(address).slice(0, 512) : null,
      punchInBattery: battery != null && !isNaN(Number(battery)) ? Math.round(Number(battery)) : null,
      punchInChecklist: checklist
        ? (typeof checklist === 'string' ? checklist : JSON.stringify(checklist))
        : null,
      stationNameId: stationId,
      guardNameId: securityGuard.id,
      postSiteId: station.postSiteId || null,
      tenantId,
      createdById: userId,
      updatedById: userId,
    });

    // Update isOnDuty
    await securityGuard.update({ isOnDuty: true });

    return ApiResponseHandler.success(req, res, {
      success: true,
      clockIn: guardShiftRecord.get({ plain: true }),
    });
  } catch (error) {
    return ApiResponseHandler.error(req, res, error);
  }
};
