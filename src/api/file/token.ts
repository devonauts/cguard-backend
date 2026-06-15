import FileStorage from '../../services/file/fileStorage';
import ApiResponseHandler from '../apiResponseHandler';
import Error401 from '../../errors/Error401';
import Error403 from '../../errors/Error403';

/**
 * GET /tenant/:tenantId/file/token?privateUrl=...
 *
 * Mints an opaque, unforgeable fileToken (AES-256-GCM) for a stored file the
 * authenticated caller already holds a privateUrl for, plus a ready-to-use
 * token-based downloadUrl. Lets the client display private files via an
 * <img src> / link without ever exposing the raw, guessable privateUrl — the
 * groundwork for enabling FILE_DOWNLOAD_REQUIRE_TOKEN.
 *
 * MUST be authenticated + tenant-scoped, or it becomes an open token oracle
 * (mint a token for any path → download anything once the kill-switch is on).
 * So we require both a current user and a current tenant, and only mint for a
 * privateUrl that belongs to that tenant.
 */
export default async (req, res) => {
  try {
    // Require authentication — without a resolved user this endpoint would
    // mint download tokens for anonymous callers.
    if (!req.currentUser) {
      throw new Error401();
    }

    const tenantId = req.currentTenant && req.currentTenant.id;
    if (!tenantId) {
      throw new Error403(req.language);
    }

    const privateUrl = req.query.privateUrl ? String(req.query.privateUrl) : '';
    if (!privateUrl) {
      throw new Error403(req.language);
    }

    // Only mint a token for a file that belongs to the caller's tenant.
    if (!privateUrl.includes(String(tenantId))) {
      throw new Error403(req.language);
    }

    const { encryptPrivateUrl } = require('../../utils/privateUrlEncryption');
    const fileToken = encryptPrivateUrl(privateUrl);
    const downloadUrl = await FileStorage.downloadUrl(privateUrl);

    return ApiResponseHandler.success(req, res, { fileToken, downloadUrl });
  } catch (error) {
    return ApiResponseHandler.error(req, res, error);
  }
};
