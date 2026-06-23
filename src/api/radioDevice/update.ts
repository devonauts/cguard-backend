import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import { encrypt } from '../../lib/secretBox';
import { serializeRadioDevice } from './serialize';

// PUT /tenant/:tenantId/radio-device/:id
export default async (req, res) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.radioDeviceEdit);
    const db = req.database;
    const tenantId = req.currentTenant.id;
    const currentUser = (req as any).currentUser;
    const body = req.body && req.body.data ? req.body.data : req.body || {};

    const record = await db.radioDevice.findOne({ where: { id: req.params.id, tenantId } });
    if (!record) {
      const err: any = new Error('Not found');
      err.code = 404;
      throw err;
    }

    const updatable = [
      'name', 'host', 'sipPort', 'transport', 'sipUsername', 'sipDomain',
      'registerRequired', 'extension', 'codec', 'rtpPortStart', 'rtpPortEnd',
      'postSiteId', 'stationId', 'notes', 'active',
    ];
    const updateData: any = { updatedById: currentUser && currentUser.id };
    updatable.forEach((f) => {
      if (typeof body[f] !== 'undefined') updateData[f] = body[f];
    });
    // Only overwrite the SIP password when a non-empty value is explicitly sent.
    if (typeof body.sipPassword !== 'undefined' && body.sipPassword !== null && body.sipPassword !== '') {
      updateData.sipPassword = encrypt(String(body.sipPassword));
    }

    await record.update(updateData);
    await ApiResponseHandler.success(req, res, serializeRadioDevice(record));
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
