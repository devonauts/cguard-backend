/**
 * Per-tenant WhatsApp Business (Meta Embedded Signup) — authed admin endpoints,
 * tenant-scoped (mounted under /tenant/:tenantId/communications/whatsapp/*).
 *
 * The frontend runs the Meta JS-SDK Embedded Signup popup with the params from
 * /connect, then posts the popup result ({code, wabaId, phoneNumberId}) to
 * /callback; all Graph API work (code exchange, validation, webhook subscribe)
 * happens server-side in tenantWhatsappService. Tokens never reach the frontend.
 */
import ApiResponseHandler from '../apiResponseHandler';
import PermissionChecker from '../../services/user/permissionChecker';
import Permissions from '../../security/permissions';
import Error400 from '../../errors/Error400';
import {
  getEmbeddedSignupParams,
  getStatus,
  completeSignup,
  registerPhone,
  disconnect,
  syncTemplates,
} from '../../services/communication/whatsapp/tenantWhatsappService';

const ctx = (req: any) => ({ db: req.database, tenantId: req.currentTenant.id });

/** GET /tenant/:tenantId/communications/whatsapp/status — masked snapshot. */
export const whatsappStatusGet = async (req: any, res: any) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.settingsRead);
    const { db, tenantId } = ctx(req);
    await ApiResponseHandler.success(req, res, await getStatus(db, tenantId));
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};

/**
 * POST /tenant/:tenantId/communications/whatsapp/connect — the public params
 * the frontend needs to launch the Embedded Signup popup (JS-SDK flow: no
 * server-side state nonce required; the code exchange itself is the proof).
 */
export const whatsappConnectPost = async (req: any, res: any) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.settingsEdit);
    await ApiResponseHandler.success(req, res, getEmbeddedSignupParams());
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};

/** POST /tenant/:tenantId/communications/whatsapp/callback — finish the signup. */
export const whatsappCallbackPost = async (req: any, res: any) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.settingsEdit);
    const { db, tenantId } = ctx(req);
    const data = (req.body && req.body.data) || req.body || {};
    if (!data.code || !data.wabaId || !data.phoneNumberId) {
      throw new Error400(req.language, 'Faltan datos del registro de WhatsApp (code, wabaId, phoneNumberId).');
    }
    const status = await completeSignup(
      db,
      tenantId,
      { code: data.code, wabaId: data.wabaId, phoneNumberId: data.phoneNumberId },
      req.currentUser?.id,
    );
    await ApiResponseHandler.success(req, res, status);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};

/** POST /tenant/:tenantId/communications/whatsapp/disconnect. */
export const whatsappDisconnectPost = async (req: any, res: any) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.settingsEdit);
    const { db, tenantId } = ctx(req);
    const status = await disconnect(db, tenantId, req.currentUser?.id);
    await ApiResponseHandler.success(req, res, status);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};

/**
 * POST /tenant/:tenantId/communications/whatsapp/register — Cloud API number
 * registration with the user-provided 2FA PIN (only needed when Meta requires
 * it before the first send).
 */
export const whatsappRegisterPost = async (req: any, res: any) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.settingsEdit);
    const { db, tenantId } = ctx(req);
    const data = (req.body && req.body.data) || req.body || {};
    const result = await registerPhone(db, tenantId, data.pin);
    await ApiResponseHandler.success(req, res, result);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};

/** POST /tenant/:tenantId/communications/whatsapp/sync-templates. */
export const whatsappSyncTemplatesPost = async (req: any, res: any) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.settingsEdit);
    const { db, tenantId } = ctx(req);
    const result = await syncTemplates(db, tenantId);
    await ApiResponseHandler.success(req, res, result);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
