/**
 * SuperAdmin · observability + audit routes.
 * Mounted under /api/superadmin by ./index.ts, behind requireSuperadmin.
 *
 * Thin route layer — all logic lives in observabilityService.ts. Payloads are
 * returned DIRECTLY via ApiResponseHandler.success (no { success, data } wrap).
 * Also hosts GET /audit (the platform audit-log feed).
 */
import ApiResponseHandler from '../apiResponseHandler';
import {
  health,
  stats,
  auditLog,
} from '../../services/superadmin/observabilityService';

export default (router) => {
  router.get('/observability/health', async (req, res) => {
    try {
      const payload = await health(req);
      await ApiResponseHandler.success(req, res, payload);
    } catch (error) {
      await ApiResponseHandler.error(req, res, error);
    }
  });

  router.get('/observability/stats', async (req, res) => {
    try {
      const payload = await stats(req);
      await ApiResponseHandler.success(req, res, payload);
    } catch (error) {
      await ApiResponseHandler.error(req, res, error);
    }
  });

  router.get('/audit', async (req, res) => {
    try {
      const payload = await auditLog(req);
      await ApiResponseHandler.success(req, res, payload);
    } catch (error) {
      await ApiResponseHandler.error(req, res, error);
    }
  });
};
