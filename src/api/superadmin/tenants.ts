/**
 * SuperAdmin · tenants routes.
 * Mounted under /api/superadmin by ./index.ts, behind requireSuperadmin, so
 * every handler can assume an authenticated platform superadmin caller.
 *
 * Thin handlers: validation + business logic live in tenantsService.ts. Each
 * mutation writes a superadmin audit entry. Payloads are returned DIRECTLY
 * (no { success, data } wrapper), matching the rest of the backend.
 */
import ApiResponseHandler from '../apiResponseHandler';
import { writeAudit } from '../../services/superadmin/superadminHelpers';
import {
  listTenants,
  getTenantDetail,
  createTenant,
  updateTenant,
  suspendTenant,
  reactivateTenant,
  deleteTenant,
  exportTenant,
} from '../../services/superadmin/tenantsService';

export default (router) => {
  // GET /tenants — paginated list (filters: search, plan, billingStatus).
  router.get('/tenants', async (req, res) => {
    try {
      const payload = await listTenants(req);
      await ApiResponseHandler.success(req, res, payload);
    } catch (error) {
      await ApiResponseHandler.error(req, res, error);
    }
  });

  // GET /tenants/:id — full TenantDetail (counts + billing). 404 if missing.
  router.get('/tenants/:id', async (req, res) => {
    try {
      const payload = await getTenantDetail(req, req.params.id);
      await ApiResponseHandler.success(req, res, payload);
    } catch (error) {
      await ApiResponseHandler.error(req, res, error);
    }
  });

  // GET /tenants/:id/export — tenant + tenant-scoped rows (capped per table).
  router.get('/tenants/:id/export', async (req, res) => {
    try {
      const payload = await exportTenant(req, req.params.id);
      await writeAudit(req, {
        action: 'tenant.export',
        targetType: 'tenant',
        targetId: req.params.id,
        tenantId: req.params.id,
        statusCode: 200,
        details: { tables: Object.keys(payload.tables || {}) },
      });
      await ApiResponseHandler.success(req, res, payload);
    } catch (error) {
      await ApiResponseHandler.error(req, res, error);
    }
  });

  // POST /tenants — create a tenant.
  router.post('/tenants', async (req, res) => {
    try {
      const payload = await createTenant(req);
      await writeAudit(req, {
        action: 'tenant.create',
        targetType: 'tenant',
        targetId: payload.id,
        tenantId: payload.id,
        statusCode: 200,
        details: { name: payload.name, email: payload.email, plan: payload.plan },
      });
      await ApiResponseHandler.success(req, res, payload);
    } catch (error) {
      await ApiResponseHandler.error(req, res, error);
    }
  });

  // PUT /tenants/:id — partial update.
  router.put('/tenants/:id', async (req, res) => {
    try {
      const payload = await updateTenant(req, req.params.id);
      await writeAudit(req, {
        action: 'tenant.update',
        targetType: 'tenant',
        targetId: req.params.id,
        tenantId: req.params.id,
        statusCode: 200,
        details: { fields: Object.keys(req.body || {}) },
      });
      await ApiResponseHandler.success(req, res, payload);
    } catch (error) {
      await ApiResponseHandler.error(req, res, error);
    }
  });

  // POST /tenants/:id/suspend — block access. Body: { reason }.
  router.post('/tenants/:id/suspend', async (req, res) => {
    try {
      const reason = (req.body || {}).reason;
      const payload = await suspendTenant(req, req.params.id, reason);
      await writeAudit(req, {
        action: 'tenant.suspend',
        targetType: 'tenant',
        targetId: req.params.id,
        tenantId: req.params.id,
        statusCode: 200,
        details: { reason: reason || null },
      });
      await ApiResponseHandler.success(req, res, payload);
    } catch (error) {
      await ApiResponseHandler.error(req, res, error);
    }
  });

  // POST /tenants/:id/reactivate — clear the suspension.
  router.post('/tenants/:id/reactivate', async (req, res) => {
    try {
      const payload = await reactivateTenant(req, req.params.id);
      await writeAudit(req, {
        action: 'tenant.reactivate',
        targetType: 'tenant',
        targetId: req.params.id,
        tenantId: req.params.id,
        statusCode: 200,
        details: {},
      });
      await ApiResponseHandler.success(req, res, payload);
    } catch (error) {
      await ApiResponseHandler.error(req, res, error);
    }
  });

  // DELETE /tenants/:id?confirm=true — soft-delete the tenant (paranoid).
  router.delete('/tenants/:id', async (req, res) => {
    try {
      const payload = await deleteTenant(req, req.params.id);
      await writeAudit(req, {
        action: 'tenant.delete',
        targetType: 'tenant',
        targetId: req.params.id,
        tenantId: req.params.id,
        statusCode: 200,
        details: { recordsDeleted: payload.recordsDeleted, tables: payload.tables },
      });
      await ApiResponseHandler.success(req, res, payload);
    } catch (error) {
      await ApiResponseHandler.error(req, res, error);
    }
  });
};
