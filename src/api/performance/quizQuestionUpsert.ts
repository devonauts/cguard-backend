/**
 * POST /api/tenant/:tenantId/quiz-bank/:bankId/questions          (create)
 * PUT  /api/tenant/:tenantId/quiz-bank/:bankId/questions/:questionId (update)
 * body.data = { prompt, options[], correctIndex, weight?, active? }
 */
import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import Error400 from '../../errors/Error400';

export default async (req: any, res: any) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.quizBankManage);
    const db = req.database;
    const tenantId =
      req.params.tenantId || (req.currentTenant && req.currentTenant.id);
    const bankId = req.params.bankId;
    const questionId = req.params.questionId;
    const data = (req.body && req.body.data) || req.body || {};
    const userId = req.currentUser.id;

    const bank = await db.quizBank.findOne({
      where: { id: bankId, tenantId, deletedAt: null },
    });
    if (!bank) throw new Error400(req.language, 'quiz.bankNotFound');

    const options = Array.isArray(data.options) ? data.options : [];
    const correctIndex = Number(data.correctIndex);

    if (questionId) {
      const q = await db.quizQuestion.findOne({
        where: { id: questionId, quizBankId: bankId, tenantId, deletedAt: null },
      });
      if (!q) throw new Error400(req.language, 'quiz.questionNotFound');
      await q.update({
        prompt: data.prompt ?? q.prompt,
        options: data.options !== undefined ? options : q.options,
        correctIndex: data.correctIndex !== undefined ? correctIndex : q.correctIndex,
        weight: data.weight !== undefined ? Number(data.weight) || 1 : q.weight,
        active: data.active !== undefined ? !!data.active : q.active,
        updatedById: userId,
      });
      return ApiResponseHandler.success(req, res, q.get({ plain: true }));
    }

    if (!data.prompt || options.length < 2) {
      throw new Error400(req.language, 'quiz.questionInvalid');
    }
    const created = await db.quizQuestion.create({
      prompt: data.prompt,
      options,
      correctIndex: Number.isFinite(correctIndex) ? correctIndex : 0,
      weight: Number(data.weight) || 1,
      active: data.active !== undefined ? !!data.active : true,
      quizBankId: bankId,
      tenantId,
      createdById: userId,
    });
    return ApiResponseHandler.success(req, res, created.get({ plain: true }));
  } catch (error) {
    return ApiResponseHandler.error(req, res, error);
  }
};
