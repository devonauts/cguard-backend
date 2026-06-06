/**
 * SuperAdmin · dashboard routes.
 * Mounted under /api/superadmin by ./index.ts, behind requireSuperadmin.
 *
 * Thin route layer — all logic lives in observabilityService.ts. Payloads are
 * returned DIRECTLY via ApiResponseHandler.success (no { success, data } wrap).
 */
import ApiResponseHandler from '../apiResponseHandler';
import { dashboard } from '../../services/superadmin/observabilityService';

export default (router) => {
  router.get('/dashboard', async (req, res) => {
    try {
      const payload = await dashboard(req);
      await ApiResponseHandler.success(req, res, payload);
    } catch (error) {
      await ApiResponseHandler.error(req, res, error);
    }
  });
};
