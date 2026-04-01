import FileStorage from '../../../services/file/fileStorage';
import ApiResponseHandler from '../../apiResponseHandler';

/**
 * Download a file from localhost.
 */
export default async (req, res, next) => {
  try {
    // Accept either a raw privateUrl or an encrypted fileToken
    let privateUrl = req.query.privateUrl;
    const fileToken = req.query.fileToken;

    if (!privateUrl && fileToken) {
      try {
        const { decryptPrivateUrl } = require('../../../utils/privateUrlEncryption');
        privateUrl = decryptPrivateUrl(String(fileToken));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error('Failed to decrypt fileToken', msg);
        return ApiResponseHandler.error(req, res, { code: '403' });
      }
    }

    if (!privateUrl) {
      return ApiResponseHandler.error(req, res, {
        code: '404',
      });
    }

    // Set CORS headers for file downloads
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');

    await ApiResponseHandler.download(
      req,
      res,
      await FileStorage.download(privateUrl),
    );
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
