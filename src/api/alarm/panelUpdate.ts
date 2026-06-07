import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import Error404 from '../../errors/Error404';

// PUT /tenant/:tenantId/alarm/panel/:id
export default async (req, res) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.businessInfoEdit);
    const db = req.database;
    const tenantId = req.currentTenant.id;
    const currentUser = (req as any).currentUser;
    const body = req.body || {};

    const record = await db.alarmPanel.findOne({
      where: { id: req.params.id, tenantId },
    });
    if (!record) throw new Error404(req.language);

    // Assign only provided fields; never blank-out the AES key when omitted.
    const updatable = [
      'name', 'accountNumber', 'protocol', 'panelType', 'make', 'model',
      'comms', 'receiverLine', 'supervisionMins', 'testIntervalHrs', 'status',
      'lastSignalAt', 'postSiteId', 'stationId', 'customerId', 'notes', 'active',
    ];
    const updateData: any = { updatedById: currentUser && currentUser.id };
    updatable.forEach((f) => {
      if (typeof body[f] !== 'undefined') updateData[f] = body[f];
    });
    // Only overwrite the DC-09 key when a non-empty value is explicitly sent.
    if (typeof body.dc09Key !== 'undefined' && body.dc09Key !== null && body.dc09Key !== '') {
      updateData.dc09Key = body.dc09Key;
    }

    await record.update(updateData);

    const plain = typeof record.get === 'function' ? record.get({ plain: true }) : record;
    delete plain.dc09Key;

    await ApiResponseHandler.success(req, res, plain);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
