/**
 * Nómina / Time & Attendance admin API. All routes are tenant-scoped and
 * permission-gated. Records are guardShifts (with attendance fields); the
 * service layer (AttendanceAdminService) reuses GuardShiftRepository's ACL so
 * supervisors only see their assigned post-sites.
 *
 * NOTE: specific paths (/dashboard, /exceptions, /corrections, /settings) are
 * registered BEFORE /:id so Express doesn't swallow them as an id.
 */
import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import AttendanceAdminService from '../../services/attendanceAdminService';

const handler =
  (permission: any, fn: (svc: AttendanceAdminService, req: any) => Promise<any>) =>
  async (req: any, res: any) => {
    try {
      new PermissionChecker(req).validateHas(permission);
      const payload = await fn(new AttendanceAdminService(req), req);
      await ApiResponseHandler.success(req, res, payload);
    } catch (error) {
      await ApiResponseHandler.error(req, res, error);
    }
  };

const P = Permissions.values;

export default (app) => {
  const base = '/tenant/:tenantId/attendance';

  // Dashboard summary
  app.get(`${base}/dashboard`, handler(P.attendanceRead, (s, req) => s.dashboard(req.query)));

  // Exceptions queue
  app.get(`${base}/exceptions`, handler(P.attendanceRead, (s, req) => s.listExceptions(req.query)));
  app.patch(
    `${base}/exceptions/:id/resolve`,
    handler(P.attendanceApprove, (s, req) => s.resolveException(req.params.id, req.body.data || req.body)),
  );

  // Manual corrections
  app.get(`${base}/corrections`, handler(P.attendanceRead, (s, req) => s.listCorrections(req.query)));
  app.patch(
    `${base}/corrections/:id/approve`,
    handler(P.attendanceApprove, (s, req) => s.applyCorrection(req.params.id, req.body.data || req.body)),
  );

  // Settings (also reachable from the global Settings area)
  app.get(`${base}/settings`, handler(P.attendanceSettingsRead, (s) => s.getSettings()));
  app.put(
    `${base}/settings`,
    handler(P.attendanceSettingsEdit, (s, req) => s.saveSettings(req.body.data || req.body)),
  );

  // Records
  app.get(base, handler(P.attendanceRead, (s, req) => s.list(req.query)));
  app.get(`${base}/:id`, handler(P.attendanceRead, (s, req) => s.findById(req.params.id)));
  app.patch(
    `${base}/:id/approve`,
    handler(P.attendanceApprove, (s, req) => s.approve(req.params.id, req.body.data || req.body)),
  );
  app.patch(
    `${base}/:id/reject`,
    handler(P.attendanceApprove, (s, req) => s.reject(req.params.id, req.body.data || req.body)),
  );
  app.post(
    `${base}/:id/correct`,
    handler(P.attendanceCorrect, (s, req) => s.correct(req.params.id, req.body.data || req.body)),
  );
};
