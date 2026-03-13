import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import GuardLicenseService from '../../services/guardLicenseService';

export default async (req, res, next) => {
  try {
    new PermissionChecker(req).validateHas(
      Permissions.values.securityGuardRead,
    );

    const licenseId = req.params.licenseId;
    const format = (req.query.format as string) || 'pdf';

    if (!['pdf'].includes(format)) {
      return res.status(400).json({ message: 'Formato no soportado' });
    }

    const service = new GuardLicenseService(req);
    const result = await service.exportToFile(licenseId, format);

    if (format === 'pdf') {
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename=license-${licenseId}.pdf`);
    }

    return res.send(result);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
