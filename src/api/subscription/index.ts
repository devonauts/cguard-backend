import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import Error400 from '../../errors/Error400';
import { getConfig } from '../../config';
import { tenantSubdomain } from '../../services/tenantSubdomain';
import TenantService from '../../services/tenantService';
import { getSummary, countBillableSeats, listBillableUsers } from '../../services/subscriptionService';
import { getStripeClient } from '../../services/stripe/stripeConfigService';
import {
  listTenantInvoices,
  syncTenantInvoicesFromStripe,
} from '../../services/platformBillingService';
import {
  grossPerUserCents,
  platformFeeCents,
  grossImplementationCents,
} from '../../lib/billingModel';

/**
 * Resolve a USABLE Stripe customer for the tenant. Reuses the stored id but
 * verifies it exists in the ACTIVE Stripe mode — ids created in test mode
 * don't exist in live mode (and vice versa), so a stale id is replaced with a
 * fresh customer instead of 500ing checkout/portal after a mode switch.
 */
async function ensureStripeCustomer(req, stripe): Promise<string> {
  const currentTenant = req.currentTenant;
  const currentUser = req.currentUser;

  const storedId = currentTenant.planStripeCustomerId;
  if (storedId) {
    try {
      const existing = await stripe.customers.retrieve(storedId);
      if (existing && !existing.deleted) return storedId;
    } catch (e: any) {
      if (e?.code !== 'resource_missing') throw e;
      // stale id from the other mode — fall through and recreate
    }
  }

  const customer = await stripe.customers.create({
    email: currentUser?.email,
    name: currentTenant.name,
    metadata: { tenantId: currentTenant.id },
  });
  await new TenantService(req).updatePlanUser(
    currentTenant.id,
    customer.id,
    currentUser.id,
  );
  currentTenant.planStripeCustomerId = customer.id;
  return customer.id;
}

/**
 * The Customer Portal needs a configuration. Instead of requiring a one-time
 * manual step in the Stripe Dashboard (per mode!), reuse the default/active
 * configuration or create a minimal one (card update + invoice history).
 */
async function ensurePortalConfiguration(stripe): Promise<string> {
  const list = await stripe.billingPortal.configurations.list({ limit: 10, active: true });
  const existing =
    (list.data || []).find((c: any) => c.is_default) || (list.data || [])[0];
  if (existing) return existing.id;

  const created = await stripe.billingPortal.configurations.create({
    business_profile: { headline: 'CGuardPro' },
    features: {
      payment_method_update: { enabled: true },
      invoice_history: { enabled: true },
    },
  });
  return created.id;
}

/**
 * Per-user subscription billing. (Namespaced under /subscription to avoid the
 * invoicing /billing/:id route, which would otherwise capture "summary".)
 *   GET  /tenant/:tenantId/subscription/summary   → trial state, seats, price quote
 *   POST /tenant/:tenantId/subscription/checkout  → Stripe subscription Checkout URL
 */
export default (app) => {
  app.get('/tenant/:tenantId/subscription/summary', async (req, res) => {
    try {
      new PermissionChecker(req).validateHas(Permissions.values.settingsRead);
      const summary = await getSummary(req.database, req.currentTenant);
      return ApiResponseHandler.success(req, res, summary);
    } catch (error) {
      return ApiResponseHandler.error(req, res, error);
    }
  });

  // Invoice history for the billing page: refresh from Stripe (best-effort —
  // the cached rows still serve if Stripe is unreachable), then return the
  // stored records with hosted/PDF links for download.
  app.get('/tenant/:tenantId/subscription/invoices', async (req, res) => {
    try {
      new PermissionChecker(req).validateHas(Permissions.values.settingsRead);

      const currentTenant = req.currentTenant;
      try {
        const stripe = await getStripeClient(req.database);
        if (stripe && currentTenant.planStripeCustomerId) {
          await syncTenantInvoicesFromStripe(req.database, currentTenant, stripe);
        }
      } catch (e) {
        console.error('[subscription invoices] stripe sync failed:', (e as any)?.message);
      }

      const invoices = await listTenantInvoices(req.database, currentTenant.id);
      return ApiResponseHandler.success(req, res, invoices);
    } catch (error) {
      return ApiResponseHandler.error(req, res, error);
    }
  });

  app.get('/tenant/:tenantId/subscription/users', async (req, res) => {
    try {
      new PermissionChecker(req).validateHas(Permissions.values.settingsRead);
      const users = await listBillableUsers(req.database, req.currentTenant.id);
      return ApiResponseHandler.success(req, res, users);
    } catch (error) {
      return ApiResponseHandler.error(req, res, error);
    }
  });

  // Stripe Customer Portal — lets the tenant add/update their card, manage
  // autopay and view invoices. Charges happen automatically via the
  // subscription created at checkout; the portal is the self-service manager.
  app.post('/tenant/:tenantId/subscription/portal', async (req, res) => {
    try {
      new PermissionChecker(req).validateHas(Permissions.values.settingsEdit);

      const currentTenant = req.currentTenant;
      const currentUser = req.currentUser;
      const stripe = await getStripeClient(req.database);
      if (!stripe) {
        throw new Error400(req.language, 'Stripe no está configurado en la plataforma.');
      }

      // Reuse or create the tenant's Stripe customer so a card can be added
      // even before the first subscription (mode-checked: stale test-mode ids
      // are replaced automatically).
      const customerId = await ensureStripeCustomer(req, stripe);

      const returnUrl = `${tenantSubdomain.frontendUrl(currentTenant)}/setting/billing`;

      const configuration = await ensurePortalConfiguration(stripe);
      const session = await stripe.billingPortal.sessions.create({
        customer: customerId,
        return_url: returnUrl,
        configuration,
      });
      return ApiResponseHandler.success(req, res, { url: session.url });
    } catch (error) {
      return ApiResponseHandler.error(req, res, error);
    }
  });

  app.post('/tenant/:tenantId/subscription/checkout', async (req, res) => {
    try {
      new PermissionChecker(req).validateHas(Permissions.values.settingsEdit);

      const currentTenant = req.currentTenant;
      const currentUser = req.currentUser;
      // Stripe keys come from the superadmin panel config (db) with env fallback.
      const stripe = await getStripeClient(req.database);
      if (!stripe) {
        throw new Error400(req.language, 'Stripe no está configurado en la plataforma.');
      }

      // Reuse or create the tenant's Stripe customer (mode-checked: stale
      // test-mode ids are replaced automatically).
      const customerId = await ensureStripeCustomer(req, stripe);

      const seats = Math.max(1, await countBillableSeats(req.database, currentTenant.id));
      const includeImplementation = !currentTenant.implementationPaidAt;

      const line_items: any[] = [
        {
          price_data: {
            currency: 'usd',
            product_data: {
              name: 'Usuarios CGuardPro',
              description: 'Suscripción mensual por usuario (guardia, supervisor, asistente o cliente)',
            },
            unit_amount: grossPerUserCents(),
            recurring: { interval: 'month' },
          },
          quantity: seats,
        },
        {
          price_data: {
            currency: 'usd',
            product_data: { name: 'Procesamiento de pago' },
            unit_amount: platformFeeCents(),
            recurring: { interval: 'month' },
          },
          quantity: 1,
        },
      ];

      if (includeImplementation) {
        line_items.push({
          price_data: {
            currency: 'usd',
            product_data: {
              name: 'Implementación (pago único)',
              description: 'Configuración inicial de la plataforma',
            },
            unit_amount: grossImplementationCents(),
          },
          quantity: 1,
        });
      }

      const returnUrl = `${tenantSubdomain.frontendUrl(currentTenant)}/setting/billing`;

      const session = await stripe.checkout.sessions.create({
        mode: 'subscription',
        payment_method_types: ['card'],
        line_items,
        customer: customerId,
        metadata: {
          tenantId: currentTenant.id,
          purpose: 'subscription_activation',
          seats: String(seats),
        },
        subscription_data: {
          metadata: { tenantId: currentTenant.id, purpose: 'subscription_activation' },
        },
        success_url: `${returnUrl}?activated=success`,
        cancel_url: `${returnUrl}?activated=cancel`,
      });

      return ApiResponseHandler.success(req, res, { url: session.url, id: session.id });
    } catch (error) {
      return ApiResponseHandler.error(req, res, error);
    }
  });
};
