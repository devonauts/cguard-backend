import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import InvoiceService from '../../services/invoiceService';

export default async (req, res, next) => {
  try {
    new PermissionChecker(req).validateHas(
      Permissions.values.estimateDownload,
    );

    const { id } = req.params;
    const format = (req.query.format as string) || 'pdf';

    if (!['pdf'].includes(format)) {
      return res.status(400).json({ message: 'Formato no soportado' });
    }

    const service = new InvoiceService(req);
    const result = await service.exportToFile(id, format);

    if (format === 'pdf') {
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename=invoice-${id}.pdf`);
    }

    return res.send(result.buffer);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
