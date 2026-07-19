/**
 * CRM supervisor management routes — the supervisor mirror of the securityGuard
 * admin API. Tenant-scoped. Gated by the existing guard permissions (which
 * admins/HR/office roles already hold), so no new RBAC permission is needed.
 */
import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import {
  listSupervisors,
  getSupervisor,
  createSupervisor,
  updateSupervisor,
} from '../../services/supervisorProfileService';
import { listSupervisorNotes, createSupervisorNote } from './supervisorNotes';
import { listSupervisorLicenses, createSupervisorLicense, updateSupervisorLicense, destroySupervisorLicense } from './supervisorLicenses';
import { coverage as supervisorCoverage, schedule as supervisorSchedule } from './supervisorCoverage';

export default (app) => {
  // Coverage (zone + covered stations) + generated schedule for one supervisor.
  app.get('/tenant/:tenantId/supervisors/:userId/coverage', supervisorCoverage);
  app.get('/tenant/:tenantId/supervisors/:userId/schedule', supervisorSchedule);

  // Notes (reuse the polymorphic note model — notableType='supervisorProfile').
  app.get('/tenant/:tenantId/supervisors/:userId/notes', listSupervisorNotes);
  app.post('/tenant/:tenantId/supervisors/:userId/notes', createSupervisorNote);

  // Licenses (supervisorLicense model, user-keyed; images via FileRepository).
  app.get('/tenant/:tenantId/supervisors/:userId/licenses', listSupervisorLicenses);
  app.post('/tenant/:tenantId/supervisors/:userId/licenses', createSupervisorLicense);
  app.put('/tenant/:tenantId/supervisors/:userId/licenses/:licenseId', updateSupervisorLicense);
  app.delete('/tenant/:tenantId/supervisors/:userId/licenses/:licenseId', destroySupervisorLicense);

  // GET /supervisors — list supervisors + profile + live clock status.
  app.get('/tenant/:tenantId/supervisors', async (req, res) => {
    try {
      new PermissionChecker(req).validateHas(Permissions.values.securityGuardRead);
      const payload = await listSupervisors(req);
      await ApiResponseHandler.success(req, res, payload);
    } catch (error) {
      await ApiResponseHandler.error(req, res, error);
    }
  });

  // GET /supervisors/:userId — one supervisor's full detail.
  app.get('/tenant/:tenantId/supervisors/:userId', async (req, res) => {
    try {
      new PermissionChecker(req).validateHas(Permissions.values.securityGuardRead);
      const payload = await getSupervisor(req, req.params.userId);
      await ApiResponseHandler.success(req, res, payload);
    } catch (error) {
      await ApiResponseHandler.error(req, res, error);
    }
  });

  // POST /supervisors — create a supervisor (user + role + profile).
  app.post('/tenant/:tenantId/supervisors', async (req, res) => {
    try {
      new PermissionChecker(req).validateHas(Permissions.values.securityGuardCreate);
      const payload = await createSupervisor(req);
      await ApiResponseHandler.success(req, res, payload);
    } catch (error) {
      await ApiResponseHandler.error(req, res, error);
    }
  });

  // PUT /supervisors/:userId — update the supervisor's profile.
  app.put('/tenant/:tenantId/supervisors/:userId', async (req, res) => {
    try {
      new PermissionChecker(req).validateHas(Permissions.values.securityGuardEdit);
      const payload = await updateSupervisor(req, req.params.userId);
      await ApiResponseHandler.success(req, res, payload);
    } catch (error) {
      await ApiResponseHandler.error(req, res, error);
    }
  });
};
