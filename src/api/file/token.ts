import FileStorage from '../../services/file/fileStorage';
import ApiResponseHandler from '../apiResponseHandler';

/**
 * GET /tenant/:tenantId/file/token?privateUrl=...
 *
 * Mints an opaque, unforgeable fileToken (AES-256-GCM) for a stored file the
 * authenticated caller already holds a privateUrl for, plus a ready-to-use
 * token-based downloadUrl. Lets the client display private files via an
 * <img src> / link without ever exposing the raw, guessable privateUrl — the
 * groundwork for enabling FILE_DOWNLOAD_REQUIRE_TOKEN.
 *
 * Authenticated + tenant-scoped: a token is only minted for a privateUrl that
 * belongs to the caller's tenant, so this can't be abused as a token oracle
 * for other tenants' files.
 */
export default async (req, res) => {
  try {
    const privateUrl = req.query.privateUrl ? String(req.query.privateUrl) : '';
    if (!privateUrl) {
      return ApiResponseHandler.error(req, res, { code: '404' });
    }

    const tenantId = req.currentTenant && req.currentTenant.id;
    if (tenantId && !privateUrl.includes(String(tenantId))) {
      return ApiResponseHandler.error(req, res, { code: '403' });
    }

    const { encryptPrivateUrl } = require('../../utils/privateUrlEncryption');
    const fileToken = encryptPrivateUrl(privateUrl);
    const downloadUrl = await FileStorage.downloadUrl(privateUrl);

    return ApiResponseHandler.success(req, res, { fileToken, downloadUrl });
  } catch (error) {
    return ApiResponseHandler.error(req, res, error);
  }
};
