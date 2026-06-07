import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import Error404 from '../../errors/Error404';

// GET /tenant/:tenantId/alarm/panel/:id
export default async (req, res) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.businessInfoRead);
    const db = req.database;
    const tenantId = req.currentTenant.id;

    const record = await db.alarmPanel.findOne({
      where: { id: req.params.id, tenantId },
      include: [
        { model: db.alarmZone, as: 'zones' },
        { model: db.alarmContact, as: 'contacts' },
      ],
    });
    if (!record) throw new Error404(req.language);

    const plain = typeof record.get === 'function' ? record.get({ plain: true }) : record;
    // SECURITY: strip the panel AES key and any contact passcodes.
    delete plain.dc09Key;
    if (Array.isArray(plain.contacts)) {
      plain.contacts.forEach((c: any) => {
        if (c) delete c.passcode;
      });
    }

    await ApiResponseHandler.success(req, res, plain);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
