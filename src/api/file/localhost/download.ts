import FileStorage from '../../../services/file/fileStorage';
import ApiResponseHandler from '../../apiResponseHandler';

/**
 * Download a file from localhost.
 */
export default async (req, res, next) => {
  try {
    const privateUrl = req.query.privateUrl;

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
