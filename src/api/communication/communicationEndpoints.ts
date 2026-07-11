/**
 * Authed admin endpoints for the unified communications layer. Tenant-scoped
 * (mounted under /tenant/:tenantId/...). Reads/writes settings, lists the
 * delivery log and reports the wallet balance.
 *
 * TODO(Frontend agent): build the Configuración → Comunicaciones UI against
 * these endpoints. TODO(Routing/Providers agents): no changes needed here.
 */
import ApiResponseHandler from '../apiResponseHandler';
import PermissionChecker from '../../services/user/permissionChecker';
import Permissions from '../../security/permissions';
import Error400 from '../../errors/Error400';
import { getStripeClient } from '../../services/stripe/stripeConfigService';
import { tenantSubdomain } from '../../services/tenantSubdomain';
import {
  getSettings,
  saveSettings,
  getWallet,
} from '../../services/communication/communicationSettingsService';
import { queryLogs } from '../../services/communication/communicationLogService';
import { CommunicationSettings } from '../../services/communication/types';

const ctx = (req: any) => ({ db: req.database, tenantId: req.currentTenant.id });

/** GET /tenant/:tenantId/communications/settings — merged settings (defaults+overrides). */
export const settingsGet = async (req: any, res: any) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.settingsRead);
    const { db, tenantId } = ctx(req);
    await ApiResponseHandler.success(req, res, await getSettings(db, tenantId));
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};

/** PUT /tenant/:tenantId/communications/settings — partial patch. */
export const settingsPut = async (req: any, res: any) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.settingsEdit);
    const { db, tenantId } = ctx(req);
    const body = (req.body?.data || req.body || {}) as Partial<CommunicationSettings>;
    const merged = await saveSettings(db, tenantId, body);
    await ApiResponseHandler.success(req, res, merged);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};

/** GET /tenant/:tenantId/communications/logs — paginated, filtered, tenant-scoped. */
export const logsGet = async (req: any, res: any) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.settingsRead);
    const { db, tenantId } = ctx(req);
    const q = req.query || {};
    const result = await queryLogs(db, tenantId, {
      channel: q.channel,
      provider: q.provider,
      status: q.status,
      messageType: q.messageType || q.type,
      from: q.from,
      to: q.to,
      page: q.page,
      limit: q.limit,
    });
    await ApiResponseHandler.success(req, res, result);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};

/** GET /tenant/:tenantId/communications/wallet — balance snapshot. */
export const walletGet = async (req: any, res: any) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.settingsRead);
    const { db, tenantId } = ctx(req);
    await ApiResponseHandler.success(req, res, await getWallet(db, tenantId));
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};

/**
 * POST /tenant/:tenantId/communications/wallet/recharge — Stripe Checkout
 * top-up for the unified communications wallet (WhatsApp + SMS via the
 * router). Mirrors the legacy /sms-account/recharge flow: the session is
 * fulfilled by the Stripe webhook (purpose=communications_recharge), which
 * credits the wallet idempotently by session id.
 */
export const walletRecharge = async (req: any, res: any) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.settingsEdit);
    const { db } = ctx(req);
    const currentTenant = req.currentTenant;
    const currentUser = req.currentUser;
    const data = (req.body && req.body.data) || req.body || {};

    // Amount in cents, $5–$1000 (same bounds as the SMS wallet top-up).
    const amountCents = Math.round(Number(data.amountCents || 0));
    if (!Number.isFinite(amountCents) || amountCents < 500 || amountCents > 100000) {
      throw new Error400(req.language, 'Monto inválido. Debe estar entre $5 y $1000.');
    }

    const stripe = await getStripeClient(db);
    if (!stripe) {
      throw new Error400(req.language, 'Stripe no está configurado en la plataforma.');
    }
    const returnUrl = `${tenantSubdomain.frontendUrl(currentTenant)}/setting/comunicaciones`;

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: [
        {
          price_data: {
            currency: 'usd',
            unit_amount: amountCents,
            product_data: {
              name: 'Recarga de saldo de comunicaciones',
              description: `Saldo para WhatsApp y SMS de ${currentTenant.name || 'su cuenta'}`,
            },
          },
          quantity: 1,
        },
      ],
      metadata: {
        tenantId: currentTenant.id,
        purpose: 'communications_recharge',
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
};
