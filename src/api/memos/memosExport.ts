import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import MemosService from '../../services/memosService';

export default async (req, res, next) => {
  try {
    new PermissionChecker(req).validateHas(
      Permissions.values.memosRead,
    );

    const format = String(req.query.format || '').toLowerCase();
    const idsQuery = req.query.ids;
    const ids = Array.isArray(idsQuery)
      ? idsQuery.map((id) => String(id))
      : idsQuery
      ? String(idsQuery).split(',').map((id) => id.trim()).filter(Boolean)
      : [];

    if (!format || !['pdf', 'excel'].includes(format)) {
      return res.status(400).json({
        message: 'Formato no soportado. Use "pdf" o "excel".',
      });
    }

    const service = new MemosService(req);
    const result = await service.exportToFile(format, { ids });

    if (format === 'pdf') {
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', 'attachment; filename=memos.pdf');
    } else if (format === 'excel') {
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', 'attachment; filename=memos.xlsx');
    }

    res.send(result);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
