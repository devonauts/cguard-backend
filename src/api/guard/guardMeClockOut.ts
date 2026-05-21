/**
 * POST /api/tenant/:tenantId/guard/me/clock-out
 * 
 * Guard clocks out. Optionally validates GPS.
 * Body: { latitude?, longitude?, observations? }
 */
import ApiResponseHandler from '../apiResponseHandler';
import Error400 from '../../errors/Error400';
import Error401 from '../../errors/Error401';

export default async (req: any, res: any) => {
  try {
    const currentUser = req.currentUser;
    if (!currentUser) throw new Error401();

    const db = req.database;
    const userId = currentUser.id;
    const tenantId = req.params.tenantId || (req.currentTenant && req.currentTenant.id);

    const { latitude, longitude, observations } = req.body.data || req.body;

    // Find securityGuard record
    const securityGuard = await db.securityGuard.findOne({
      where: { guardId: userId, tenantId, deletedAt: null },
    });

    if (!securityGuard) {
      throw new Error400(req.language, 'guard.profileNotFound');
    }

    // Find active clock-in
    const activeClock = await db.guardShift.findOne({
      where: { guardNameId: securityGuard.id, punchOutTime: null, tenantId },
      order: [['punchInTime', 'DESC']],
    });

    if (!activeClock) {
      return ApiResponseHandler.success(req, res, {
        success: false,
        error: 'not_clocked_in',
        message: 'No tienes un registro de entrada activo.',
      });
    }

    // Update the clock-in record with punch-out data
    await activeClock.update({
      punchOutTime: new Date(),
      punchOutLatitude: latitude != null ? Number(latitude) : null,
      punchOutLongitude: longitude != null ? Number(longitude) : null,
      observations: observations || activeClock.observations,
    });

    // Update isOnDuty
    await securityGuard.update({ isOnDuty: false });

    return ApiResponseHandler.success(req, res, {
      success: true,
      clockOut: activeClock.get({ plain: true }),
    });
  } catch (error) {
    return ApiResponseHandler.error(req, res, error);
  }
};
