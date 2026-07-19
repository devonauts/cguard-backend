/**
 * GET /api/tenant/:tenantId/guard/me/quiz
 * Returns a sanitized random N-question security test for the authenticated
 * guard's station (the first assigned station that has an active quiz bank).
 * `correctIndex` is never included. Returns { hasQuiz:false } when none exists.
 */
import ApiResponseHandler from '../apiResponseHandler';
import Error401 from '../../errors/Error401';
import QuizService from '../../services/quizService';
import { stationIdsForGuard } from '../../services/assignedStationsService';

export default async (req: any, res: any) => {
  try {
    const currentUser = req.currentUser;
    if (!currentUser) throw new Error401();
    const db = req.database;
    const userId = currentUser.id;
    const tenantId =
      req.params.tenantId || (req.currentTenant && req.currentTenant.id);

    // Stations the guard is assigned to (guardAssignment — single source of truth).
    const assignedStationIds = await stationIdsForGuard(db, tenantId, userId);
    const stations = assignedStationIds.length
      ? await db.station.findAll({
          where: { tenantId, deletedAt: null, id: assignedStationIds },
          attributes: ['id', 'stationName'],
        })
      : [];

    for (const st of stations) {
      const attempt = await QuizService.buildAttempt(db, tenantId, st.id);
      if (attempt) {
        return ApiResponseHandler.success(req, res, {
          hasQuiz: true,
          stationName: st.stationName || null,
          ...attempt,
        });
      }
    }

    return ApiResponseHandler.success(req, res, { hasQuiz: false });
  } catch (error) {
    return ApiResponseHandler.error(req, res, error);
  }
};
