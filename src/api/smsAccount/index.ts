import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import Error400 from '../../errors/Error400';
import { getConfig } from '../../config';
import { tenantSubdomain } from '../../services/tenantSubdomain';
import { getStripeClient } from '../../services/stripe/stripeConfigService';
import {
  getAccount,
  provisionSubaccount,
  listTransactions,
  listAvailableNumbers,
  buyNumber,
} from '../../services/smsAccountService';

/**
 * Per-tenant SMS account: Twilio subaccount + prepaid wallet.
 *   GET    /tenant/:tenantId/sms-account              → status + balance + recent ledger
 *   POST   /tenant/:tenantId/sms-account/provision    → create the Twilio subaccount
 *   POST   /tenant/:tenantId/sms-account/recharge     → Stripe checkout session (top-up)
 *   GET    /tenant/:tenantId/sms-account/transactions → full ledger
 */
export default (app) => {
  app.get('/tenant/:tenantId/sms-account', async (req, res) => {
    try {
      new PermissionChecker(req).validateHas(Permissions.values.settingsRead);
      const db = req.database;
      const tenantId = req.currentTenant.id;
      const account = await getAccount(db, tenantId);
      const transactions = await listTransactions(db, tenantId, 20);
      return ApiResponseHandler.success(req, res, { account, transactions });
    } catch (error) {
      return ApiResponseHandler.error(req, res, error);
    }
  });

  app.get('/tenant/:tenantId/sms-account/transactions', async (req, res) => {
    try {
      new PermissionChecker(req).validateHas(Permissions.values.settingsRead);
      const db = req.database;
      const tenantId = req.currentTenant.id;
      const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
      const transactions = await listTransactions(db, tenantId, limit);
      return ApiResponseHandler.success(req, res, { transactions });
    } catch (error) {
      return ApiResponseHandler.error(req, res, error);
    }
  });

  app.post('/tenant/:tenantId/sms-account/provision', async (req, res) => {
    try {
      new PermissionChecker(req).validateHas(Permissions.values.settingsEdit);
      const db = req.database;
      const account = await provisionSubaccount(db, req.currentTenant);
      return ApiResponseHandler.success(req, res, { account });
    } catch (error) {
      return ApiResponseHandler.error(req, res, error);
    }
  });

  app.get('/tenant/:tenantId/sms-account/available-numbers', async (req, res) => {
    try {
      new PermissionChecker(req).validateHas(Permissions.values.settingsEdit);
      const db = req.database;
      const numbers = await listAvailableNumbers(db, req.currentTenant, {
        country: req.query.country,
        areaCode: req.query.areaCode,
        contains: req.query.contains,
        limit: req.query.limit,
      });
      return ApiResponseHandler.success(req, res, { numbers });
    } catch (error) {
      return ApiResponseHandler.error(req, res, error);
    }
  });

  app.post('/tenant/:tenantId/sms-account/buy-number', async (req, res) => {
    try {
      new PermissionChecker(req).validateHas(Permissions.values.settingsEdit);
      const db = req.database;
      const data = (req.body && req.body.data) || req.body || {};
      const account = await buyNumber(db, req.currentTenant, {
        phoneNumber: data.phoneNumber,
        country: data.country,
        areaCode: data.areaCode,
      });
      return ApiResponseHandler.success(req, res, { account });
    } catch (error) {
      return ApiResponseHandler.error(req, res, error);
    }
  });

  app.post('/tenant/:tenantId/sms-account/recharge', async (req, res) => {
    try {
      new PermissionChecker(req).validateHas(Permissions.values.settingsEdit);

      const currentTenant = req.currentTenant;
      const currentUser = req.currentUser;
      const data = (req.body && req.body.data) || req.body || {};

      // Amount in cents, $5–$1000.
      const amountCents = Math.round(Number(data.amountCents || 0));
      if (!Number.isFinite(amountCents) || amountCents < 500 || amountCents > 100000) {
        throw new Error400(req.language, 'Monto inválido. Debe estar entre $5 y $1000.');
      }

      const stripe = await getStripeClient(req.database);
      if (!stripe) {
        throw new Error400(req.language, 'Stripe no está configurado en la plataforma.');
      }
      const returnUrl = `${tenantSubdomain.frontendUrl(currentTenant)}/setting/sms`;

      const session = await stripe.checkout.sessions.create({
        mode: 'payment',
        payment_method_types: ['card'],
        line_items: [
          {
            price_data: {
              currency: 'usd',
              unit_amount: amountCents,
              product_data: {
                name: 'Recarga de saldo SMS',
                description: `Saldo de mensajería SMS para ${currentTenant.name || 'su cuenta'}`,
              },
            },
            quantity: 1,
          },
        ],
        metadata: {
          tenantId: currentTenant.id,
          purpose: 'sms_recharge',
          amountCents: String(amountCents),
        },
        success_url: `${returnUrl}?recharge=success`,
        cancel_url: `${returnUrl}?recharge=cancel`,
        ...(currentTenant.planStripeCustomerId
          ? { customer: currentTenant.planStripeCustomerId }
          : { customer_email: currentUser?.email || undefined }),
      });

      return ApiResponseHandler.success(req, res, { url: session.url, id: session.id });
    } catch (error) {
      return ApiResponseHandler.error(req, res, error);
    }
  });
};
