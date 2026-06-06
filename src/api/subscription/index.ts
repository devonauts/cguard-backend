import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import Error400 from '../../errors/Error400';
import { getConfig } from '../../config';
import { tenantSubdomain } from '../../services/tenantSubdomain';
import TenantService from '../../services/tenantService';
import { getSummary, countBillableSeats } from '../../services/subscriptionService';
import {
  grossPerUserCents,
  platformFeeCents,
  grossImplementationCents,
} from '../../lib/billingModel';

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

  app.post('/tenant/:tenantId/subscription/checkout', async (req, res) => {
    try {
      new PermissionChecker(req).validateHas(Permissions.values.settingsEdit);

      if (!getConfig().PLAN_STRIPE_SECRET_KEY) {
        throw new Error400(req.language, 'Stripe no está configurado en la plataforma.');
      }

      const currentTenant = req.currentTenant;
      const currentUser = req.currentUser;
      const stripe = require('stripe')(getConfig().PLAN_STRIPE_SECRET_KEY);

      // Reuse or create the tenant's Stripe customer.
      let customerId = currentTenant.planStripeCustomerId;
      if (!customerId) {
        const customer = await stripe.customers.create({
          email: currentUser?.email,
          name: currentTenant.name,
          metadata: { tenantId: currentTenant.id },
        });
        customerId = customer.id;
        await new TenantService(req).updatePlanUser(
          currentTenant.id,
          customerId,
          currentUser.id,
        );
      }

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
