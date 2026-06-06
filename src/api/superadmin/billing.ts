/**
 * SuperAdmin · billing routes.
 * Mounted under /api/superadmin by ./index.ts, behind requireSuperadmin.
 *
 * Read-only billing analytics & invoice listing. Payloads are returned DIRECTLY
 * via ApiResponseHandler.success. Business logic lives in billingService.
 */
import ApiResponseHandler from '../apiResponseHandler';
import {
  billingOverview,
  billingTenants,
  billingTenantDetail,
  billingInvoices,
} from '../../services/superadmin/billingService';

export default (router) => {
  router.get('/billing/overview', async (req, res) => {
    try {
      await ApiResponseHandler.success(req, res, await billingOverview(req));
    } catch (error) {
      await ApiResponseHandler.error(req, res, error);
    }
  });

  router.get('/billing/tenants', async (req, res) => {
    try {
      await ApiResponseHandler.success(req, res, await billingTenants(req));
    } catch (error) {
      await ApiResponseHandler.error(req, res, error);
    }
  });

  router.get('/billing/tenants/:id', async (req, res) => {
    try {
      await ApiResponseHandler.success(req, res, await billingTenantDetail(req));
    } catch (error) {
      await ApiResponseHandler.error(req, res, error);
    }
  });

  router.get('/billing/invoices', async (req, res) => {
    try {
      await ApiResponseHandler.success(req, res, await billingInvoices(req));
    } catch (error) {
      await ApiResponseHandler.error(req, res, error);
    }
  });
};
