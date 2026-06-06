/**
 * DELETE /api/tenant/:tenantId/quiz-bank/:bankId/questions/:questionId
 * Soft-deletes a question from a quiz bank.
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

    const q = await db.quizQuestion.findOne({
      where: {
        id: req.params.questionId,
        quizBankId: req.params.bankId,
        tenantId,
        deletedAt: null,
      },
    });
    if (q) await q.destroy();
    return ApiResponseHandler.success(req, res, { id: req.params.questionId });
  } catch (error) {
    return ApiResponseHandler.error(req, res, error);
  }
};
