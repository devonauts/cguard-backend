import ApiResponseHandler from '../apiResponseHandler';
import PermissionChecker from '../../services/user/permissionChecker';
import Permissions from '../../security/permissions';
import {
  generateProposal,
  getProposal,
  publishProposal,
  discardProposal,
  getImplementationPlan,
} from '../../services/scheduleProposalService';
import { computeCoverage, requiredHalves } from '../../services/scheduleCoverageService';

/** POST /scheduler/proposals — generate a DRAFT horario (no live writes). */
export const proposalGenerate = async (req, res) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.stationEdit);
    const body = req.body?.data || req.body || {};
    const scope = body.scope || (body.stationId ? 'station' : body.postSiteId ? 'postSite' : 'tenant');
    const result = await generateProposal(
      req.database,
      req.currentTenant.id,
      req.currentUser.id,
      { scope, stationId: body.stationId || null, postSiteId: body.postSiteId || null, title: body.title || null },
    );
    await ApiResponseHandler.success(req, res, result);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};

/** GET /scheduler/proposals/:id — the draft + its staged diff for review. */
export const proposalGet = async (req, res) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.stationRead);
    const data = await getProposal(req.database, req.currentTenant.id, req.params.id);
    if (!data) return ApiResponseHandler.error(req, res, new Error('Proposal not found'));
    await ApiResponseHandler.success(req, res, data);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};

/** POST /scheduler/proposals/:id/publish — apply to live shifts. Requires confirm. */
export const proposalPublish = async (req, res) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.stationEdit);
    const body = req.body?.data || req.body || {};
    if (body.confirm !== true) {
      return ApiResponseHandler.error(req, res, new Error('Confirmation required to overwrite the schedule'));
    }
    const result = await publishProposal(
      req.database,
      req.currentTenant.id,
      req.currentUser.id,
      req.params.id,
      { allowGaps: body.allowGaps === true },
    );
    await ApiResponseHandler.success(req, res, result);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};

/**
 * GET /scheduler/coverage — real coverage of the LIVE schedule for a scope.
 * Asserts every (station, day, day/night-half) has exactly one guard; returns
 * gaps (empty puestos) and overstaff. Reads persisted shifts, not a recompute.
 */
export const coverageGet = async (req, res) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.stationRead);
    const db = req.database;
    const tenantId = req.currentTenant.id;
    const { Op } = db.Sequelize;
    const q = req.query || {};
    const days = Math.min(parseInt(q.days, 10) || 14, 31);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const end = new Date(today.getTime() + days * 86_400_000);

    const stationWhere: any = { tenantId, deletedAt: null, scheduleType: { [Op.ne]: null } };
    if (q.stationId) stationWhere.id = q.stationId;
    else if (q.postSiteId) stationWhere.postSiteId = q.postSiteId;

    const stns = await db.station.findAll({ where: stationWhere, attributes: ['id', 'stationName', 'scheduleType'] });
    const stationIds = stns.map((s: any) => s.id);
    const shifts = stationIds.length
      ? await db.shift.findAll({
          where: { tenantId, stationId: { [Op.in]: stationIds }, startTime: { [Op.gte]: today, [Op.lt]: end } },
          attributes: ['stationId', 'guardId', 'startTime'],
        })
      : [];

    const stationReqs = stns.map((s: any) => ({ stationId: s.id, stationName: s.stationName, halves: requiredHalves(s.scheduleType) }));
    const tenant = await db.tenant.findByPk(tenantId, { attributes: ['timezone'] });
    const tz = (tenant && tenant.timezone) || 'UTC';
    const cov = computeCoverage(shifts, stationReqs, today, days, tz);
    await ApiResponseHandler.success(req, res, cov);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};

/** GET /scheduler/proposals/:id/plan — the per-guard implementation plan. */
export const proposalPlan = async (req, res) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.stationRead);
    const data = await getImplementationPlan(req.database, req.currentTenant.id, req.params.id);
    await ApiResponseHandler.success(req, res, data || { plan: null, items: [] });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};

/** POST /scheduler/proposals/:id/discard — drop the draft (no live effect). */
export const proposalDiscard = async (req, res) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.stationEdit);
    const result = await discardProposal(req.database, req.currentTenant.id, req.currentUser.id, req.params.id);
    await ApiResponseHandler.success(req, res, result);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
