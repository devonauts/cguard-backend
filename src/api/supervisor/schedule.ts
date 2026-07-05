import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import { upcomingForUser } from '../../services/supervisorScheduleService';

/**
 * GET /supervisor/me/schedule — the supervisor's upcoming shifts, DERIVED from
 * the rotation of the puesto(s) they're assigned to (supervisorScheduledShifts).
 * The schedule lives on the position, never on the user — this just reads the
 * generated plan for the signed-in supervisor.
 */
export const getSchedule = async (req: any, res: any) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.supervisorMe);
    const db = req.database;
    const tenantId = req.currentTenant.id;
    const userId = req.currentUser.id;

    const shifts = await upcomingForUser(db, tenantId, userId, 30);
    const rows = shifts.map((s: any) => ({
      date: s.start ? new Date(s.start).toISOString().slice(0, 10) : null,
      start: s.start,
      end: s.end,
      kind: s.kind,
      position: s.position,
    }));

    await ApiResponseHandler.success(req, res, {
      rows,
      position: shifts.length ? shifts[0].position : null,
    });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};

export default getSchedule;
