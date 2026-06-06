import { getConfig } from '../../../config';
import TenantService from '../../../services/tenantService';
import Plans from '../../../security/plans';
import ApiResponseHandler from '../../apiResponseHandler';
import lodash from 'lodash';
import { credit as creditSmsWallet } from '../../../services/smsAccountService';

export default async (req, res) => {
  try {
    /** @openapi { "summary": "Stripe webhook receiver", "description": "Receives raw Stripe webhook payloads. Expects raw body and `stripe-signature` header.", "requestBody": { "content": { "application/json": { "schema": { "type": "object" } } } }, "responses": { "200": { "description": "Received" }, "400": { "description": "Error" } } } */

    const stripe = require('stripe')(
      getConfig().PLAN_STRIPE_SECRET_KEY,
    );

    const event = stripe.webhooks.constructEvent(
      req.rawBody,
      req.headers['stripe-signature'],
      getConfig().PLAN_STRIPE_WEBHOOK_SIGNING_SECRET,
    );

    // SMS wallet top-up — one-time payment, identified by session metadata.
    // Handle before the plan logic (it has price_data, not a plan price id).
    if (
      event.type === 'checkout.session.completed' &&
      lodash.get(event, 'data.object.metadata.purpose') === 'sms_recharge'
    ) {
      const session = event.data.object;
      const tenantId = lodash.get(session, 'metadata.tenantId');
      const amountCents =
        Number(lodash.get(session, 'metadata.amountCents')) ||
        Number(lodash.get(session, 'amount_total')) ||
        0;

      if (tenantId && amountCents > 0 && lodash.get(session, 'payment_status') !== 'unpaid') {
        await creditSmsWallet(req.database, tenantId, amountCents, {
          reference: session.id,
          description: 'Recarga de saldo SMS (Stripe)',
          currency: (session.currency || 'usd').toUpperCase(),
        });
      }

      return ApiResponseHandler.success(req, res, { received: true });
    }

    // Per-user subscription activation — first successful checkout after trial.
    if (
      event.type === 'checkout.session.completed' &&
      lodash.get(event, 'data.object.metadata.purpose') === 'subscription_activation'
    ) {
      const session = event.data.object;
      const tenantId = lodash.get(session, 'metadata.tenantId');
      if (tenantId) {
        await req.database.tenant.update(
          {
            billingStatus: 'active',
            stripeSubscriptionId: session.subscription || null,
            implementationPaidAt: new Date(),
            ...(session.customer ? { planStripeCustomerId: session.customer } : {}),
          },
          { where: { id: tenantId } },
        );
      }
      return ApiResponseHandler.success(req, res, { received: true });
    }

    // Recurring invoice outcomes flip the per-user billing status.
    if (event.type === 'invoice.payment_failed') {
      const customerId = lodash.get(event, 'data.object.customer');
      if (customerId) {
        await req.database.tenant.update(
          { billingStatus: 'past_due' },
          { where: { planStripeCustomerId: customerId } },
        );
      }
      return ApiResponseHandler.success(req, res, { received: true });
    }
    if (event.type === 'invoice.paid' || event.type === 'invoice.payment_succeeded') {
      const customerId = lodash.get(event, 'data.object.customer');
      if (customerId) {
        await req.database.tenant.update(
          { billingStatus: 'active' },
          { where: { planStripeCustomerId: customerId } },
        );
      }
      return ApiResponseHandler.success(req, res, { received: true });
    }

    if (event.type === 'checkout.session.completed') {
      let data = event.data.object;
      data = await stripe.checkout.sessions.retrieve(
        data.id,
        { expand: ['line_items'] },
      );

      const stripePriceId = lodash.get(
        data,
        'line_items.data[0].price.id',
      );

      if (!stripePriceId) {
        throw new Error(
          'line_items.data[0].price.id NULL!',
        );
      }

      const plan = Plans.selectPlanByStripePriceId(
        stripePriceId,
      );
      const planStripeCustomerId = data.customer;

      await new TenantService(req).updatePlanStatus(
        planStripeCustomerId,
        plan,
        'active',
      );
    }

    if (event.type === 'customer.subscription.updated') {
      const data = event.data.object;

      const stripePriceId = lodash.get(
        data,
        'items.data[0].price.id',
      );
      const plan = Plans.selectPlanByStripePriceId(
        stripePriceId,
      );
      const planStripeCustomerId = data.customer;

      if (Plans.selectPlanStatus(data) === 'canceled') {
        await new TenantService(req).updatePlanToFree(
          planStripeCustomerId,
        );
      } else {
        await new TenantService(req).updatePlanStatus(
          planStripeCustomerId,
          plan,
          Plans.selectPlanStatus(data),
        );
      }
    }

    if (event.type === 'customer.subscription.deleted') {
      const data = event.data.object;

      const planStripeCustomerId = data.customer;

      await new TenantService(req).updatePlanToFree(
        planStripeCustomerId,
      );

      if (planStripeCustomerId) {
        await req.database.tenant.update(
          { billingStatus: 'canceled', stripeSubscriptionId: null },
          { where: { planStripeCustomerId } },
        );
      }
    }

    return ApiResponseHandler.success(req, res, {
      received: true,
    });
  } catch (error) {
    return ApiResponseHandler.error(req, res, error);
  }
};
