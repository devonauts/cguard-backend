/**
 * SuperAdmin · users routes (CONTRACT §1 "Users").
 * Mounted under /api/superadmin by ./index.ts, behind requireSuperadmin.
 *
 * Thin: all logic lives in ../../services/superadmin/usersService.
 * Handlers return the payload DIRECTLY (no { success, data } wrapper).
 */
import ApiResponseHandler from '../apiResponseHandler';
import {
  listUsers,
  getUser,
  setUserStatus,
  listGuards,
} from '../../services/superadmin/usersService';

export default (router) => {
  // GET /users — paginated cross-tenant tenantUser list.
  router.get('/users', async (req, res) => {
    try {
      const payload = await listUsers(req);
      await ApiResponseHandler.success(req, res, payload);
    } catch (error) {
      await ApiResponseHandler.error(req, res, error);
    }
  });

  // GET /guards — paginated cross-tenant securityGuard list.
  // (Registered before /users/:tenantUserId so it can't be shadowed.)
  router.get('/guards', async (req, res) => {
    try {
      const payload = await listGuards(req);
      await ApiResponseHandler.success(req, res, payload);
    } catch (error) {
      await ApiResponseHandler.error(req, res, error);
    }
  });

  // GET /users/:tenantUserId — single UserRow (404 if missing).
  router.get('/users/:tenantUserId', async (req, res) => {
    try {
      const payload = await getUser(req, req.params.tenantUserId);
      await ApiResponseHandler.success(req, res, payload);
    } catch (error) {
      await ApiResponseHandler.error(req, res, error);
    }
  });

  // POST /users/:tenantUserId/status { status } — set status (active|archived).
  router.post('/users/:tenantUserId/status', async (req, res) => {
    try {
      const payload = await setUserStatus(
        req,
        req.params.tenantUserId,
        (req.body && req.body.status) as string,
      );
      await ApiResponseHandler.success(req, res, payload);
    } catch (error) {
      await ApiResponseHandler.error(req, res, error);
    }
  });
};
