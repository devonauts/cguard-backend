import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import { encrypt } from '../../lib/secretBox';
import { genPublishToken, serializeRelaySite } from './_relaySite';

// PUT /tenant/:tenantId/video/relay-site/:id   (body.regenToken=true rotates the token)
export default async (req, res) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.businessInfoEdit);
    const db = req.database;
    const tenantId = req.currentTenant.id;
    const currentUser = (req as any).currentUser;
    const body = req.body && req.body.data ? req.body.data : req.body || {};

    const record = await db.videoRelaySite.findOne({ where: { id: req.params.id, tenantId } });
    if (!record) { const err: any = new Error('Not found'); err.code = 404; throw err; }

    const updateData: any = { updatedById: currentUser && currentUser.id };
    ['name', 'ingestProtocol', 'notes', 'active'].forEach((f) => {
      if (typeof body[f] !== 'undefined') updateData[f] = body[f];
    });
    if (body.regenToken) updateData.publishToken = encrypt(genPublishToken());

    await record.update(updateData);
    await ApiResponseHandler.success(req, res, serializeRelaySite(record));
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
