/**
 * GET /tenant/:tenantId/alarm/case/:id/clips
 * Video-verification clips captured/linked for an alarm case.
 * Tenant-scoped; businessInfoRead.
 */
import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import Error404 from '../../errors/Error404';

export default async (req, res) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.businessInfoRead);
    const db = req.database;
    const tenantId = req.currentTenant.id;

    const c = await db.alarmCase.findOne({ where: { id: req.params.id, tenantId } });
    if (!c) throw new Error404();

    const clips = await db.videoClip.findAll({
      where: { alarmCaseId: c.id, tenantId },
      order: [['createdAt', 'DESC']],
    });

    await ApiResponseHandler.success(req, res, (clips || []).map((x: any) => (typeof x.get === 'function' ? x.get({ plain: true }) : x)));
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
