/**
 * POST /api/tenant/:tenantId/guard/me/quiz/submit
 * body.data = { bankId, stationId?, startedAt?, answers: [{questionId, chosenIndex}] }
 * Grades the answers server-side against the bank and stores a quizAttempt.
 */
import ApiResponseHandler from '../apiResponseHandler';
import Error401 from '../../errors/Error401';
import Error400 from '../../errors/Error400';
import QuizService from '../../services/quizService';

export default async (req: any, res: any) => {
  try {
    const currentUser = req.currentUser;
    if (!currentUser) throw new Error401();
    const db = req.database;
    const userId = currentUser.id;
    const tenantId =
      req.params.tenantId || (req.currentTenant && req.currentTenant.id);
    const data = (req.body && req.body.data) || req.body || {};

    if (!data.bankId) throw new Error400(req.language, 'quiz.bankRequired');
    if (!Array.isArray(data.answers) || !data.answers.length) {
      throw new Error400(req.language, 'quiz.answersRequired');
    }

    const securityGuard = await db.securityGuard.findOne({
      where: { guardId: userId, tenantId, deletedAt: null },
      attributes: ['id'],
    });

    const result = await QuizService.gradeAndSave(db, {
      tenantId,
      bankId: data.bankId,
      stationId: data.stationId || null,
      subjectUserId: userId,
      securityGuardId: securityGuard?.id || null,
      subjectType: securityGuard ? 'guard' : 'supervisor',
      answers: data.answers,
      startedAt: data.startedAt ? new Date(data.startedAt) : null,
    });

    return ApiResponseHandler.success(req, res, result);
  } catch (error) {
    return ApiResponseHandler.error(req, res, error);
  }
};
