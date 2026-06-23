import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import { requestRegister } from '../../services/radio/sipBridgeControl';
import { serializeRadioDevice } from './serialize';

// POST /tenant/:tenantId/radio-device/:id/test
// Asks the cguard-sip-bridge process to (re)register this gateway now. The bridge
// writes back status/lastError onto the row; the UI re-fetches to see the result.
// Until the bridge process is running, this just records the request (status stays
// 'unknown'/'pending') — wiring the live SIP path is Phase 2.
export default async (req, res) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.radioDeviceEdit);
    const db = req.database;
    const tenantId = req.currentTenant.id;

    const record = await db.radioDevice.findOne({ where: { id: req.params.id, tenantId } });
    if (!record) {
      const err: any = new Error('Not found');
      err.code = 404;
      throw err;
    }

    const dispatched = await requestRegister(tenantId, record.id);
    await ApiResponseHandler.success(req, res, {
      requested: true,
      dispatched, // true if the bridge control message was published
      device: serializeRadioDevice(record),
    });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
