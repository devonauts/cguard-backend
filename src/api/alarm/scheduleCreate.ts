import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import Error404 from '../../errors/Error404';

// POST /tenant/:tenantId/alarm/panel/:id/schedule
// Body: { dayOfWeek, openTime, closeTime, graceMins }
export default async (req, res) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.businessInfoEdit);
    const db = req.database;
    const tenantId = req.currentTenant.id;
    const raw = (req.body && req.body.data) || req.body || {};

    const panel = await db.alarmPanel.findOne({
      where: { id: req.params.id, tenantId },
    });
    if (!panel) throw new Error404();

    const record = await db.openCloseSchedule.create({
      alarmPanelId: panel.id,
      dayOfWeek: typeof raw.dayOfWeek !== 'undefined' ? raw.dayOfWeek : null,
      openTime: raw.openTime || null,
      closeTime: raw.closeTime || null,
      graceMins: typeof raw.graceMins !== 'undefined' ? raw.graceMins : 15,
      tenantId,
    });

    const plain = typeof record.get === 'function' ? record.get({ plain: true }) : record;
    await ApiResponseHandler.success(req, res, plain);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
