/**
 * Supervisor attendance management — thin wrappers over the SAME tested,
 * ACL-scoped AttendanceAdminService the admin Nómina API uses. Supervisors
 * already hold attendanceRead/attendanceApprove (SUPERVISOR_ROLES) and the
 * service scopes every read/write to their assigned post-sites via
 * GuardShiftRepository's ACL, so this reuses the proven guardShift write paths
 * with ZERO new guardShift code. Lets a supervisor approve/reject a guard's
 * late clock-in / early clock-out, approve/reject a punch, and resolve
 * attendance exceptions — from the supervisor app.
 */
import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import AttendanceAdminService from '../../services/attendanceAdminService';

const body = (req: any) => (req.body && req.body.data) || req.body || {};

/** GET /supervisor/me/attendance/pending — everything awaiting the supervisor. */
export const getPendingAttendance = async (req: any, res: any) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.attendanceRead);
    const s = new AttendanceAdminService(req);
    const [clockIn, clockOut, exceptions] = await Promise.all([
      s.listClockInRequests({}).catch(() => []),
      s.listClockOutRequests({}).catch(() => []),
      s.listExceptions({ status: 'open' }).catch(() => []),
    ]);
    const rows = (v: any) => (Array.isArray(v) ? v : v?.rows || []);
    await ApiResponseHandler.success(req, res, {
      clockInRequests: rows(clockIn),
      clockOutRequests: rows(clockOut),
      exceptions: rows(exceptions),
    });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};

const decision = (fn: (s: AttendanceAdminService, req: any) => Promise<any>) =>
  async (req: any, res: any) => {
    try {
      new PermissionChecker(req).validateHas(Permissions.values.attendanceApprove);
      const payload = await fn(new AttendanceAdminService(req), req);
      await ApiResponseHandler.success(req, res, payload);
    } catch (error) {
      await ApiResponseHandler.error(req, res, error);
    }
  };

/** POST /supervisor/me/attendance/clock-in-requests/:id/decision { status, notes? } */
export const decideClockIn = decision((s, req) =>
  s.decideClockInRequest(req.params.id, body(req)));

/** POST /supervisor/me/attendance/clock-out-requests/:id/decision { status, notes? } */
export const decideClockOut = decision((s, req) =>
  s.decideClockOutRequest(req.params.id, body(req)));

/** POST /supervisor/me/attendance/:id/approve { notes? } — approve a punch. */
export const approvePunch = decision((s, req) => s.approve(req.params.id, body(req)));

/** POST /supervisor/me/attendance/:id/reject { notes? } — reject a punch. */
export const rejectPunch = decision((s, req) => s.reject(req.params.id, body(req)));

/** POST /supervisor/me/attendance/exceptions/:id/resolve { status?, resolutionNotes? } */
export const resolveAttendanceException = decision((s, req) =>
  s.resolveException(req.params.id, body(req)));
