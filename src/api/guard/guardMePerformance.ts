/**
 * GET /api/tenant/:tenantId/guard/me/performance?period=30
 *
 * Returns the authenticated guard's performance score + breakdown for the
 * rolling period (days). See GuardPerformanceService for the algorithm.
 */
import ApiResponseHandler from '../apiResponseHandler';
import Error401 from '../../errors/Error401';
import GuardPerformanceService from '../../services/guardPerformanceService';

export default async (req: any, res: any) => {
  try {
    const currentUser = req.currentUser;
    if (!currentUser) throw new Error401();

    const periodDays = Math.min(
      180,
      Math.max(7, Number(req.query.period) || 30),
    );

    const detail = (() => {
      const d = req.query.detail;
      return d === '1' || d === 'true' || d === 1 || d === true;
    })();

    const payload = await new GuardPerformanceService(req).forUser(
      currentUser.id,
      periodDays,
      detail,
    );

    return ApiResponseHandler.success(req, res, payload);
  } catch (error) {
    return ApiResponseHandler.error(req, res, error);
  }
};
