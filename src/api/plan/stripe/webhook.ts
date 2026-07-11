import TenantService from '../../../services/tenantService';
import Plans from '../../../security/plans';
import ApiResponseHandler from '../../apiResponseHandler';
import lodash from 'lodash';
import { credit as creditSmsWallet } from '../../../services/smsAccountService';
import { creditWalletFromRecharge } from '../../../services/communication/communicationSettingsService';
import { resolveStripe } from '../../../services/stripe/stripeConfigService';
import { upsertInvoiceFromStripe } from '../../../services/platformBillingService';

/**
 * Look up the tenant that owns a Stripe customer id. Returns null when no
 * tenant matches — callers must treat that as "not ours / already gone" and
 * ACK the event instead of erroring (a thrown error makes Stripe retry the
 * same event forever).
 */
async function findTenantByCustomer(database: any, customerId: string | null) {
  if (!customerId) return null;
  return database.tenant.findOne({
    where: { planStripeCustomerId: customerId },
  });
}

export default async (req, res) => {
  try {
    /** @openapi { "summary": "Stripe webhook receiver", "description": "Receives raw Stripe webhook payloads. Expects raw body and `stripe-signature` header.", "requestBody": { "content": { "application/json": { "schema": { "type": "object" } } } }, "responses": { "200": { "description": "Received" }, "400": { "description": "Error" } } } */

    // Keys from the superadmin panel config (db) with env fallback.
    const { secretKey, webhookSecret } = await resolveStripe(req.database);
    const stripe = require('stripe')(secretKey);

    const event = stripe.webhooks.constructEvent(
      req.rawBody,
      req.headers['stripe-signature'],
      webhookSecret,
    );

    // SMS wallet top-up — one-time payment, identified by session metadata.
    // Handle before the plan logic (it has price_data, not a plan price id).
    // creditSmsWallet dedupes by reference=session.id, so retries are safe.
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

    // Unified communications wallet top-up (WhatsApp + SMS via the router).
    // creditWalletFromRecharge dedupes by reference=session.id → retry-safe.
    if (
      event.type === 'checkout.session.completed' &&
      lodash.get(event, 'data.object.metadata.purpose') === 'communications_recharge'
    ) {
      const session = event.data.object;
      const tenantId = lodash.get(session, 'metadata.tenantId');
      const amountCents =
        Number(lodash.get(session, 'metadata.amountCents')) ||
        Number(lodash.get(session, 'amount_total')) ||
        0;

      if (tenantId && amountCents > 0 && lodash.get(session, 'payment_status') !== 'unpaid') {
        await creditWalletFromRecharge(req.database, tenantId, amountCents, {
          reference: session.id,
          description: 'Recarga de saldo de comunicaciones (Stripe)',
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

        // Persist the first invoice right away so the billing page shows it
        // without waiting for the separate invoice.paid delivery.
        try {
          if (session.invoice) {
            const inv = await stripe.invoices.retrieve(session.invoice);
            await upsertInvoiceFromStripe(req.database, inv, tenantId);
          }
        } catch (e) {
          console.error('[stripe webhook] first-invoice persist failed:', (e as any)?.message);
        }
      }
      return ApiResponseHandler.success(req, res, { received: true });
    }

    // Recurring invoice outcomes: persist the invoice record (tenant history +
    // superadmin feed + PDF links) and flip the per-user billing status.
    if (
      event.type === 'invoice.payment_failed' ||
      event.type === 'invoice.paid' ||
      event.type === 'invoice.payment_succeeded' ||
      event.type === 'invoice.finalized' ||
      event.type === 'invoice.voided' ||
      event.type === 'invoice.marked_uncollectible'
    ) {
      const invoice = event.data.object;
      const customerId = lodash.get(invoice, 'customer');

      try {
        await upsertInvoiceFromStripe(req.database, invoice);
      } catch (e) {
        console.error('[stripe webhook] invoice persist failed:', (e as any)?.message);
      }

      if (event.type === 'invoice.payment_failed' && customerId) {
        await req.database.tenant.update(
          { billingStatus: 'past_due' },
          { where: { planStripeCustomerId: customerId } },
        );
      }
      if ((event.type === 'invoice.paid' || event.type === 'invoice.payment_succeeded') && customerId) {
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

      // Unknown customer → not a tenant of ours; ACK instead of erroring so
      // Stripe doesn't retry forever.
      if (await findTenantByCustomer(req.database, planStripeCustomerId)) {
        await new TenantService(req).updatePlanStatus(
          planStripeCustomerId,
          plan,
          'active',
        );
      }
    }

    if (event.type === 'customer.subscription.updated') {
      const data = event.data.object;

      // Per-seat subscriptions use dynamic price_data, so their price ids map
      // to 'free' in the legacy tier lookup — handling them here would
      // silently downgrade tenant.plan on every seat sync. Their lifecycle is
      // driven by the invoice.* events above instead.
      if (lodash.get(data, 'metadata.purpose') === 'subscription_activation') {
        return ApiResponseHandler.success(req, res, { received: true });
      }

      const stripePriceId = lodash.get(
        data,
        'items.data[0].price.id',
      );
      const plan = Plans.selectPlanByStripePriceId(
        stripePriceId,
      );
      const planStripeCustomerId = data.customer;

      if (await findTenantByCustomer(req.database, planStripeCustomerId)) {
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
    }

    if (event.type === 'customer.subscription.deleted') {
      const data = event.data.object;

      const planStripeCustomerId = data.customer;
      const isPerSeat =
        lodash.get(data, 'metadata.purpose') === 'subscription_activation';

      if (await findTenantByCustomer(req.database, planStripeCustomerId)) {
        // Legacy tier subscriptions drop back to the free tier. Per-seat
        // subscriptions keep their catalog tier — the canceled billingStatus
        // already locks the account, and a later comp/reactivation shouldn't
        // find the tenant silently downgraded.
        if (!isPerSeat) {
          await new TenantService(req).updatePlanToFree(
            planStripeCustomerId,
          );
        }

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
