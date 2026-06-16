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
