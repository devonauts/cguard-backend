import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import { upcomingTurnos } from '../../lib/supervisorTurno';

/**
 * GET /supervisor/me/schedule — the supervisor's OWN upcoming turno windows
 * (derived from their turno config), plus the config itself. Replaces the app's
 * previous reliance on /guard-shift (guards' shifts), which never showed the
 * supervisor's own turno.
 */
export const getSchedule = async (req: any, res: any) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.supervisorMe);
    const db = req.database;
    const tenantId = req.currentTenant.id;
    const userId = req.currentUser.id;
    const tz = (req.currentTenant && req.currentTenant.timezone) || 'America/Guayaquil';

    const profile = await db.supervisorProfile.findOne({ where: { tenantId, supervisorUserId: userId } });
    const windows = profile ? upcomingTurnos(profile, new Date(), tz, 14) : [];
    const rows = windows.map((w) => ({
      date: w.date,
      start: w.scheduledStart,
      end: w.scheduledEnd,
      kind: w.shiftKind,
    }));

    await ApiResponseHandler.success(req, res, {
      rows,
      turno: profile
        ? { days: profile.turnoDays || null, start: profile.turnoStart || null, end: profile.turnoEnd || null }
        : null,
    });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};

export default getSchedule;
