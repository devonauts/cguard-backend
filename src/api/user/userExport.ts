import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import UserService from '../../services/userService';

export default async (req, res) => {
  try {
    new PermissionChecker(req).validateHas(
      Permissions.values.userExport,
    );

    const format = (req.query.format || req.body.format || 'pdf').toString();
    const filter = req.query.filter || req.body.filter || {};

    const result = await new UserService(req).exportToFile(format, filter);

    if (result && result.buffer) {
      const filename = `users.${format === 'excel' ? 'xlsx' : 'pdf'}`;
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('Content-Type', result.mimeType);
      return res.send(result.buffer);
    }

    await ApiResponseHandler.success(req, res, null);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
