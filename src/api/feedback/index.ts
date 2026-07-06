/**
 * App feedback — a CRM user rates their C-Guard Pro experience (header modal).
 * POST /tenant/:tenantId/feedback { rating, comment }. Any authenticated tenant
 * user may submit. Surfaced to superadmin across all tenants.
 */
import ApiResponseHandler from '../apiResponseHandler';
import Error400 from '../../errors/Error400';

export default (app) => {
  app.post('/tenant/:tenantId/feedback', async (req: any, res: any) => {
    try {
      const db = req.database;
      const tenantId = req.currentTenant?.id;
      const userId = req.currentUser?.id;
      if (!tenantId || !userId) throw new Error400(req.language);

      const data = (req.body && req.body.data) || req.body || {};
      const rating = Math.max(1, Math.min(5, parseInt(String(data.rating), 10) || 0));
      if (!rating) throw new Error400(req.language, undefined, 'rating is required (1-5)');
      const comment = data.comment ? String(data.comment).slice(0, 2000) : null;

      const row = await db.appFeedback.create({
        tenantId,
        userId,
        rating,
        comment,
        source: 'crm',
        createdById: userId,
        updatedById: userId,
      });

      await ApiResponseHandler.success(req, res, { id: String(row.id), rating, comment });
    } catch (error) {
      await ApiResponseHandler.error(req, res, error);
    }
  });
};
