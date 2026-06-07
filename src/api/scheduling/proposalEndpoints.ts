import ApiResponseHandler from '../apiResponseHandler';
import {
  generateProposal,
  getProposal,
  publishProposal,
  discardProposal,
  getImplementationPlan,
} from '../../services/scheduleProposalService';

/** POST /scheduler/proposals — generate a DRAFT horario (no live writes). */
export const proposalGenerate = async (req, res) => {
  try {
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
    const body = req.body?.data || req.body || {};
    if (body.confirm !== true) {
      return ApiResponseHandler.error(req, res, new Error('Confirmation required to overwrite the schedule'));
    }
    const result = await publishProposal(req.database, req.currentTenant.id, req.currentUser.id, req.params.id);
    await ApiResponseHandler.success(req, res, result);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};

/** GET /scheduler/proposals/:id/plan — the per-guard implementation plan. */
export const proposalPlan = async (req, res) => {
  try {
    const data = await getImplementationPlan(req.database, req.currentTenant.id, req.params.id);
    await ApiResponseHandler.success(req, res, data || { plan: null, items: [] });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};

/** POST /scheduler/proposals/:id/discard — drop the draft (no live effect). */
export const proposalDiscard = async (req, res) => {
  try {
    const result = await discardProposal(req.database, req.currentTenant.id, req.currentUser.id, req.params.id);
    await ApiResponseHandler.success(req, res, result);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
