/**
 * SuperAdmin · plan catalog routes. Mounted under /api/superadmin behind
 * requireSuperadmin. Thin handlers → plansService.ts. Every mutation writes a
 * superadmin audit entry.
 */
import ApiResponseHandler from '../apiResponseHandler';
import { writeAudit } from '../../services/superadmin/superadminHelpers';
import {
  listPlans,
  createPlan,
  updatePlan,
  deletePlan,
} from '../../services/superadmin/plansService';

export default (router) => {
  // GET /plans — catalog + feature registry + per-plan tenant counts.
  router.get('/plans', async (req, res) => {
    try {
      const payload = await listPlans(req);
      await ApiResponseHandler.success(req, res, payload);
    } catch (error) {
      await ApiResponseHandler.error(req, res, error);
    }
  });

  // POST /plans — create a tier.
  router.post('/plans', async (req, res) => {
    try {
      const payload = await createPlan(req);
      await writeAudit(req, {
        action: 'plan.create',
        targetType: 'planCatalog',
        targetId: payload.id,
        statusCode: 200,
        details: { key: payload.key, name: payload.name },
      });
      await ApiResponseHandler.success(req, res, payload);
    } catch (error) {
      await ApiResponseHandler.error(req, res, error);
    }
  });

  // PUT /plans/:id — update a tier.
  router.put('/plans/:id', async (req, res) => {
    try {
      const payload = await updatePlan(req, req.params.id);
      await writeAudit(req, {
        action: 'plan.update',
        targetType: 'planCatalog',
        targetId: req.params.id,
        statusCode: 200,
        details: { fields: Object.keys(req.body || {}) },
      });
      await ApiResponseHandler.success(req, res, payload);
    } catch (error) {
      await ApiResponseHandler.error(req, res, error);
    }
  });

  // DELETE /plans/:id — soft-delete a tier (blocked if in use).
  router.delete('/plans/:id', async (req, res) => {
    try {
      const payload = await deletePlan(req, req.params.id);
      await writeAudit(req, {
        action: 'plan.delete',
        targetType: 'planCatalog',
        targetId: req.params.id,
        statusCode: 200,
        details: {},
      });
      await ApiResponseHandler.success(req, res, payload);
    } catch (error) {
      await ApiResponseHandler.error(req, res, error);
    }
  });
};
