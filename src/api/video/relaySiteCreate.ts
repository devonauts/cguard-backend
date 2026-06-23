import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import { encrypt } from '../../lib/secretBox';
import { genSiteKey, genPublishToken, serializeRelaySite } from './_relaySite';

// POST /tenant/:tenantId/video/relay-site
// Auto-generates a siteKey + publish token (token stored encrypted, never returned;
// it's embedded server-side into the downloadable relay bundle).
export default async (req, res) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.businessInfoEdit);
    const db = req.database;
    const tenantId = req.currentTenant.id;
    const currentUser = (req as any).currentUser;
    const body = req.body && req.body.data ? req.body.data : req.body || {};

    const record = await db.videoRelaySite.create({
      name: body.name,
      siteKey: genSiteKey(body.name),
      publishToken: encrypt(genPublishToken()),
      ingestProtocol: body.ingestProtocol || 'rtmps',
      status: 'unknown',
      notes: body.notes || null,
      active: typeof body.active !== 'undefined' ? !!body.active : true,
      tenantId,
      createdById: currentUser && currentUser.id,
      updatedById: currentUser && currentUser.id,
    });

    await ApiResponseHandler.success(req, res, serializeRelaySite(record));
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
