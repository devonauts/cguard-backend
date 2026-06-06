/**
 * GET /api/tenant/:tenantId/station/:stationId/quiz-bank
 * Full quiz bank + questions (incl. correctIndex) for management.
 */
import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';

export default async (req: any, res: any) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.quizBankManage);
    const db = req.database;
    const tenantId =
      req.params.tenantId || (req.currentTenant && req.currentTenant.id);
    const stationId = req.params.stationId;

    const bank = await db.quizBank.findOne({
      where: { tenantId, stationId, deletedAt: null },
    });
    if (!bank) {
      return ApiResponseHandler.success(req, res, { bank: null, questions: [] });
    }
    const questions = await db.quizQuestion.findAll({
      where: { tenantId, quizBankId: bank.id, deletedAt: null },
      order: [['createdAt', 'ASC']],
    });
    return ApiResponseHandler.success(req, res, {
      bank: bank.get({ plain: true }),
      questions: questions.map((q: any) => q.get({ plain: true })),
    });
  } catch (error) {
    return ApiResponseHandler.error(req, res, error);
  }
};
