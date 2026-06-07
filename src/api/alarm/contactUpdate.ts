import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import Error404 from '../../errors/Error404';

// PUT /tenant/:tenantId/alarm/contact/:id
export default async (req, res) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.businessInfoEdit);
    const db = req.database;
    const tenantId = req.currentTenant.id;
    const raw = (req.body && req.body.data) || req.body || {};

    const contact = await db.alarmContact.findOne({
      where: { id: req.params.id, tenantId },
    });
    if (!contact) throw new Error404();

    const mapped: any = {};
    const fields = ['name', 'phone', 'email', 'callOrder', 'passcode', 'authority'];
    for (const f of fields) {
      if (raw[f] !== undefined) mapped[f] = raw[f];
    }

    await contact.update(mapped);

    // SECURITY: never return the verbal passcode.
    const plain = typeof contact.get === 'function' ? contact.get({ plain: true }) : contact;
    delete plain.passcode;

    await ApiResponseHandler.success(req, res, plain);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
