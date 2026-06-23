import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import { encrypt } from '../../lib/secretBox';
import { serializeRadioDevice } from './serialize';

const num = (v: any, d: number) =>
  typeof v !== 'undefined' && v !== null && v !== '' ? Number(v) : d;

// POST /tenant/:tenantId/radio-device
export default async (req, res) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.radioDeviceCreate);
    const db = req.database;
    const tenantId = req.currentTenant.id;
    const currentUser = (req as any).currentUser;
    const body = req.body && req.body.data ? req.body.data : req.body || {};

    const payload: any = {
      name: body.name,
      host: body.host || null,
      sipPort: num(body.sipPort, 5060),
      transport: body.transport || 'udp',
      sipUsername: body.sipUsername || null,
      // Encrypt the SIP password at rest; never stored or returned in clear.
      sipPassword: body.sipPassword ? encrypt(String(body.sipPassword)) : null,
      sipDomain: body.sipDomain || null,
      registerRequired:
        typeof body.registerRequired !== 'undefined' ? !!body.registerRequired : true,
      extension: body.extension || null,
      codec: body.codec || 'pcmu',
      rtpPortStart: num(body.rtpPortStart, 16000),
      rtpPortEnd: num(body.rtpPortEnd, 16100),
      status: 'unknown',
      postSiteId: body.postSiteId || null,
      stationId: body.stationId || null,
      notes: body.notes || null,
      active: typeof body.active !== 'undefined' ? !!body.active : true,
      tenantId,
      createdById: currentUser && currentUser.id,
      updatedById: currentUser && currentUser.id,
    };

    const record = await db.radioDevice.create(payload);
    await ApiResponseHandler.success(req, res, serializeRadioDevice(record));
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
