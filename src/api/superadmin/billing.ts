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
  tenantSubscriptionInvoices,
  recentPlatformPayments,
  refundSubscriptionInvoice,
  cancelStripeSubscription,
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

  // ── Stripe subscription payments (platform charges to tenants) ──────────

  // Per-tenant Stripe invoice history (refreshes from Stripe, then serves DB).
  router.get('/billing/tenants/:id/subscription-invoices', async (req, res) => {
    try {
      await ApiResponseHandler.success(req, res, await tenantSubscriptionInvoices(req));
    } catch (error) {
      await ApiResponseHandler.error(req, res, error);
    }
  });

  // Cross-tenant recent payments feed.
  router.get('/billing/payments', async (req, res) => {
    try {
      await ApiResponseHandler.success(req, res, await recentPlatformPayments(req));
    } catch (error) {
      await ApiResponseHandler.error(req, res, error);
    }
  });

  // Refund a paid subscription invoice (full refund via its payment intent).
  router.post('/billing/tenants/:id/subscription-invoices/:invoiceId/refund', async (req, res) => {
    try {
      await ApiResponseHandler.success(req, res, await refundSubscriptionInvoice(req));
    } catch (error) {
      await ApiResponseHandler.error(req, res, error);
    }
  });

  // Cancel the tenant's REAL Stripe subscription (immediately or at period end).
  router.post('/billing/tenants/:id/subscription/cancel', async (req, res) => {
    try {
      await ApiResponseHandler.success(req, res, await cancelStripeSubscription(req));
    } catch (error) {
      await ApiResponseHandler.error(req, res, error);
    }
  });
};
