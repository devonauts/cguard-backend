/**
 * PUT /api/tenant/:tenantId/station/:stationId/quiz-bank
 * body.data = { title?, questionsPerAttempt?, passPct?, active? }
 * Creates or updates the station's quiz bank settings.
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
    const data = (req.body && req.body.data) || req.body || {};
    const userId = req.currentUser.id;

    const fields: any = {};
    if (data.title !== undefined) fields.title = data.title;
    if (data.questionsPerAttempt !== undefined)
      fields.questionsPerAttempt = Number(data.questionsPerAttempt) || 10;
    if (data.passPct !== undefined) fields.passPct = Number(data.passPct) || 70;
    if (data.active !== undefined) fields.active = !!data.active;

    let bank = await db.quizBank.findOne({
      where: { tenantId, stationId, deletedAt: null },
    });
    if (bank) {
      await bank.update({ ...fields, updatedById: userId });
    } else {
      bank = await db.quizBank.create({
        title: data.title || null,
        questionsPerAttempt: Number(data.questionsPerAttempt) || 10,
        passPct: Number(data.passPct) || 70,
        active: data.active !== undefined ? !!data.active : true,
        stationId,
        tenantId,
        createdById: userId,
      });
    }
    return ApiResponseHandler.success(req, res, bank.get({ plain: true }));
  } catch (error) {
    return ApiResponseHandler.error(req, res, error);
  }
};
