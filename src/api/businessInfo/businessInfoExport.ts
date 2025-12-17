import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import BusinessInfoService from '../../services/businessInfoService';

export default async (req, res, next) => {
  try {
    new PermissionChecker(req).validateHas(
      Permissions.values.businessInfoRead,
    );

    const format = req.query.format as string;

    if (!format || !['pdf', 'excel'].includes(format)) {
      return res.status(400).json({
        message: 'Formato no soportado. Use "pdf" o "excel".',
      });
    }

    const service = new BusinessInfoService(req);
    const result = await service.exportToFile(format, req.query.filter);

    if (format === 'pdf') {
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', 'attachment; filename=business-info.pdf');
    } else if (format === 'excel') {
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', 'attachment; filename=business-info.xlsx');
    }

    res.send(result);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
