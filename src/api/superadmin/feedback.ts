/**
 * SuperAdmin · app-feedback routes. Mounted under /api/superadmin by ./index.ts,
 * behind requireSuperadmin. GET /superadmin/feedback — cross-tenant list + summary.
 */
import ApiResponseHandler from '../apiResponseHandler';
import { listFeedback } from '../../services/superadmin/feedbackService';

export default (router) => {
  router.get('/feedback', async (req, res) => {
    try {
      const payload = await listFeedback(req);
      await ApiResponseHandler.success(req, res, payload);
    } catch (error) {
      await ApiResponseHandler.error(req, res, error);
    }
  });
};
