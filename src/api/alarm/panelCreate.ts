import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';

// POST /tenant/:tenantId/alarm/panel
export default async (req, res) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.businessInfoEdit);
    const db = req.database;
    const tenantId = req.currentTenant.id;
    const currentUser = (req as any).currentUser;
    const body = req.body || {};

    const payload: any = {
      name: body.name,
      accountNumber: body.accountNumber || null,
      protocol: body.protocol || 'sia-dc09',
      panelType: body.panelType || 'intrusion',
      make: body.make || null,
      model: body.model || null,
      comms: body.comms || 'ip',
      receiverLine: body.receiverLine || null,
      // SECURITY: AES key for DC-09 — stored, never returned.
      dc09Key:
        typeof body.dc09Key !== 'undefined' && body.dc09Key !== ''
          ? body.dc09Key
          : null,
      supervisionMins:
        typeof body.supervisionMins !== 'undefined' && body.supervisionMins !== null
          ? Number(body.supervisionMins)
          : 0,
      testIntervalHrs:
        typeof body.testIntervalHrs !== 'undefined' && body.testIntervalHrs !== null
          ? Number(body.testIntervalHrs)
          : null,
      status: body.status || 'unknown',
      lastSignalAt: body.lastSignalAt || null,
      postSiteId: body.postSiteId || null,
      stationId: body.stationId || null,
      customerId: body.customerId || null,
      notes: body.notes || null,
      active: typeof body.active !== 'undefined' ? body.active : true,
      tenantId,
      createdById: currentUser && currentUser.id,
      updatedById: currentUser && currentUser.id,
    };

    const record = await db.alarmPanel.create(payload);
    const plain = typeof record.get === 'function' ? record.get({ plain: true }) : record;
    delete plain.dc09Key;

    await ApiResponseHandler.success(req, res, plain);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
