import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import BusinessInfoService from '../../services/businessInfoService';
import multer from 'multer';

const upload = multer({ storage: multer.memoryStorage() });

export default [
  upload.single('file'),
  async (req, res, next) => {
    try {
      new PermissionChecker(req).validateHas(
        Permissions.values.businessInfoImport,
      );

      console.log('🔍 DEBUG: req.file =', req.file);
      console.log('🔍 DEBUG: req.body =', req.body);

      let data = req.body.data;

      if (!data && req.file) {
        const ExcelJS = require('exceljs');
        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.load(req.file.buffer);

        const worksheet = workbook.getWorksheet(1);
        data = [];

        const extractValue = (val) => {
          if (!val) return '';
          if (typeof val === 'string') return val.trim();
          if (typeof val === 'number') return val.toString();
          if (val.text) return val.text.toString().trim();
          if (val.hyperlink) return val.hyperlink.toString().trim();
          return val.toString().trim();
        };

        worksheet.eachRow((row, rowNumber) => {
          // Skip header row(s) if necessary; assume headers in first row
          if (rowNumber === 1) return;

          const values = row.values;

          const companyName = extractValue(values[1]);
          const description = extractValue(values[2]);
          const contactPhone = extractValue(values[3]);
          const contactEmail = extractValue(values[4]);
          const address = extractValue(values[5]);
          const secondAddress = extractValue(values[6]) || '';
          const postalCode = extractValue(values[7]) || '';
          const city = extractValue(values[8]) || '';
          const country = extractValue(values[9]) || '';
          const latitud = extractValue(values[10]) || '';
          const longitud = extractValue(values[11]) || '';

          if (companyName && address) {
            data.push({
              companyName,
              description,
              contactPhone,
              contactEmail,
              address,
              secondAddress,
              postalCode,
              city,
              country,
              latitud,
              longitud,
              active: true,
            });
          }
        });
      }

      if (!data || (Array.isArray(data) && data.length === 0)) {
        return await ApiResponseHandler.error(req, res, {
          message: 'No se encontraron datos válidos para importar',
        });
      }

      const importHash = req.body.importHash || `import_${Date.now()}_${Math.random().toString(36).substring(7)}`;

      let payload;

      if (Array.isArray(data)) {
        payload = await new BusinessInfoService(req).importMultiple(
          data,
          importHash,
        );

        const responsePayload = {
          ...payload,
          message: `Importación completada: ${payload.success} registros importados exitosamente${payload.skipped > 0 ? `, ${payload.skipped} omitidos` : ''}${payload.failed > 0 ? `, ${payload.failed} fallidos` : ''}`,
        };

        await ApiResponseHandler.success(req, res, responsePayload);
      } else {
        payload = await new BusinessInfoService(req).import(
          data,
          importHash,
        );

        await ApiResponseHandler.success(req, res, {
          ...payload,
          message: 'Registro importado exitosamente',
        });
      }
    } catch (error) {
      await ApiResponseHandler.error(req, res, error);
    }
  }
];
