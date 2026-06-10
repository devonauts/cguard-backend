import ApiResponseHandler from '../apiResponseHandler';
import PermissionChecker from '../../services/user/permissionChecker';
import Permissions from '../../security/permissions';
import {
  getSettings,
  upsertSettings,
  startSession,
  cancelSession,
  getConsole,
  listSessions,
  getSession,
} from '../../services/radioCheckService';
import { generateSummary } from '../../services/radioCheckAiService';

const ctx = (req: any) => ({ db: req.database, tenantId: req.currentTenant.id, userId: req.currentUser.id });

/** GET /radio-check/console — live grid of stations + on-duty guard + latest status. */
export const radioConsole = async (req, res) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.radioCheckRead);
    const { db, tenantId } = ctx(req);
    await ApiResponseHandler.success(req, res, await getConsole(db, tenantId));
  } catch (error) { await ApiResponseHandler.error(req, res, error); }
};

/** POST /radio-check/start { scope:'all'|'station', stationId? } — manual roll call. */
export const radioStart = async (req, res) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.radioCheckManage);
    const { db, tenantId, userId } = ctx(req);
    const body = req.body?.data || req.body || {};
    const scope = body.scope === 'station' ? 'station' : 'all';
    if (scope === 'station' && !body.stationId) {
      return ApiResponseHandler.error(req, res, Object.assign(new Error('stationId es obligatorio'), { code: 400 }));
    }
    const session = await startSession(db, tenantId, { mode: 'manual', initiatedByUserId: userId, scope, stationId: body.stationId });
    await ApiResponseHandler.success(req, res, session.get ? session.get({ plain: true }) : session);
  } catch (error) { await ApiResponseHandler.error(req, res, error); }
};

/** GET /radio-check/sessions?status= — history. */
export const radioSessions = async (req, res) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.radioCheckRead);
    const { db, tenantId } = ctx(req);
    const rows = await listSessions(db, tenantId, parseInt(req.query?.limit, 10) || 30);
    await ApiResponseHandler.success(req, res, { rows });
  } catch (error) { await ApiResponseHandler.error(req, res, error); }
};

/** GET /radio-check/sessions/:id — session + entries (transcripts/audio/summary). */
export const radioSessionGet = async (req, res) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.radioCheckRead);
    const { db, tenantId } = ctx(req);
    const data = await getSession(db, tenantId, req.params.id);
    if (!data) return ApiResponseHandler.error(req, res, Object.assign(new Error('Sesión no encontrada'), { code: 404 }));
    await ApiResponseHandler.success(req, res, data);
  } catch (error) { await ApiResponseHandler.error(req, res, error); }
};

/** POST /radio-check/sessions/:id/cancel. */
export const radioSessionCancel = async (req, res) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.radioCheckManage);
    const { db, tenantId } = ctx(req);
    await cancelSession(db, tenantId, req.params.id);
    await ApiResponseHandler.success(req, res, { ok: true });
  } catch (error) { await ApiResponseHandler.error(req, res, error); }
};

/** POST /radio-check/sessions/:id/summary — (re)generate the roll-call summary. */
export const radioSessionSummary = async (req, res) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.radioCheckManage);
    const { db, tenantId } = ctx(req);
    await generateSummary(db, tenantId, req.params.id);
    const data = await getSession(db, tenantId, req.params.id);
    await ApiResponseHandler.success(req, res, data);
  } catch (error) { await ApiResponseHandler.error(req, res, error); }
};

/** POST /radio-check/entries/:entryId/escalate — flag a reply as an incident. */
export const radioEntryEscalate = async (req, res) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.radioCheckManage);
    const { db, tenantId } = ctx(req);
    const entry = await db.radioCheckEntry.findOne({ where: { id: req.params.entryId, tenantId, deletedAt: null } });
    if (!entry) return ApiResponseHandler.error(req, res, Object.assign(new Error('Entrada no encontrada'), { code: 404 }));
    await entry.update({ classification: 'incident' });
    await db.radioCheckSession.increment('incidentCount', { where: { id: entry.sessionId, tenantId } }).catch(() => {});
    await ApiResponseHandler.success(req, res, { ok: true });
  } catch (error) { await ApiResponseHandler.error(req, res, error); }
};

/** GET /radio-check/settings. */
export const radioSettingsGet = async (req, res) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.radioCheckSettingsRead);
    const { db, tenantId } = ctx(req);
    const s = await getSettings(db, tenantId);
    await ApiResponseHandler.success(req, res, s.get ? s.get({ plain: true }) : s);
  } catch (error) { await ApiResponseHandler.error(req, res, error); }
};

/** PUT /radio-check/settings. */
export const radioSettingsPut = async (req, res) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.radioCheckSettingsEdit);
    const { db, tenantId, userId } = ctx(req);
    const body = req.body?.data || req.body || {};
    const s = await upsertSettings(db, tenantId, body, userId);
    await ApiResponseHandler.success(req, res, s.get ? s.get({ plain: true }) : s);
  } catch (error) { await ApiResponseHandler.error(req, res, error); }
};
