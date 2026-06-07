import crypto from 'crypto';
import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import Error404 from '../../errors/Error404';

// POST /tenant/:tenantId/video/clip/:id/share
// Generate a share token + 7-day expiry; return a public share URL.
export default async (req, res) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.businessInfoEdit);
    const db = req.database;
    const tenantId = req.currentTenant.id;

    const clip = await db.videoClip.findOne({
      where: { id: req.params.id, tenantId },
    });
    if (!clip) throw new Error404();

    const token = crypto.randomBytes(24).toString('hex');
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    await clip.update({ shareToken: token, shareExpiresAt: expiresAt });

    const frontendBase = (
      process.env.FRONTEND_URL ||
      process.env.CLIENT_URL ||
      ''
    ).replace(/\/+$/, '');
    const url = `${frontendBase}/video/shared/${token}`;

    await ApiResponseHandler.success(req, res, {
      token,
      url,
      expiresAt: expiresAt.toISOString(),
    });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
