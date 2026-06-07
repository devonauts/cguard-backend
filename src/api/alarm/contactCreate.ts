import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import Error404 from '../../errors/Error404';

// POST /tenant/:tenantId/alarm/panel/:id/contact
// Body: { name, phone, email, callOrder, passcode, authority }
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

    const record = await db.alarmContact.create({
      alarmPanelId: panel.id,
      name: raw.name || null,
      phone: raw.phone || null,
      email: raw.email || null,
      callOrder: typeof raw.callOrder !== 'undefined' ? raw.callOrder : 1,
      passcode: raw.passcode || null,
      authority: raw.authority || null,
      tenantId,
    });

    // SECURITY: never return the verbal passcode.
    const plain = typeof record.get === 'function' ? record.get({ plain: true }) : record;
    delete plain.passcode;

    await ApiResponseHandler.success(req, res, plain);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
