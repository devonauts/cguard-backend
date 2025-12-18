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

    // Parse optional categories filter. Accepts:
    // - JSON array string: '["cat1","cat2"]'
    // - CSV string: 'cat1,cat2'
    // - Repeated query params: ?categories=cat1&categories=cat2
    const categoriesQuery = req.query.categories as any;
    let categories: string[] | undefined;

    if (categoriesQuery) {
      if (Array.isArray(categoriesQuery)) {
        categories = categoriesQuery.map(String);
      } else if (typeof categoriesQuery === 'string') {
        const raw = categoriesQuery.trim();
        try {
          if (raw.startsWith('[')) {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) {
              categories = parsed.map(String);
            } else {
              return res.status(400).json({ message: 'Formato de categorías inválido.' });
            }
          } else {
            categories = raw.split(',').map((s) => s.trim()).filter(Boolean);
          }
        } catch (err) {
          return res.status(400).json({ message: 'Formato de categorías inválido.' });
        }
      }
    }

    // Normalize incoming filter (may be stringified JSON or object)
    const rawFilter = req.query.filter as any;
    let filterObj: any = {};
    if (rawFilter) {
      if (typeof rawFilter === 'string') {
        try {
          filterObj = JSON.parse(rawFilter);
        } catch (err) {
          filterObj = { q: rawFilter };
        }
      } else {
        filterObj = rawFilter;
      }
    }

    if (categories) {
      filterObj.categories = categories;
      // Repository expects `categoryIds` for filtering stored JSON array
      // If multiple categories provided, pass the array and repository will handle it.
      filterObj.categoryIds = categories.length === 1 ? categories[0] : categories;
    }

    // Accept alias keys from frontend: `email` -> `contactEmail`, `phone` -> `contactPhone`
    if (filterObj.email && !filterObj.contactEmail) {
      filterObj.contactEmail = filterObj.email;
    }

    if (filterObj.phone && !filterObj.contactPhone) {
      filterObj.contactPhone = filterObj.phone;
    }

    const service = new BusinessInfoService(req);
    const result = await service.exportToFile(format, filterObj);

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
