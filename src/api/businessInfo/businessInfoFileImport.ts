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
          if (val && typeof val === 'object' && val.text) return val.text.toString().trim();
          if (val && typeof val === 'object' && val.hyperlink) return val.hyperlink.toString().trim();
          return String(val).toString().trim();
        };

        // Build header map from first row so we accept Spanish or English column names
        const headerMap = {}; // index (1-based) -> internal field key or special
        const mapHeader = (h) => {
          if (!h) return null;
          const s = h.toString().trim().toLowerCase();

          // Cliente identifiers
          if (['clientid','clienteid','client id','idcliente','cliente id','client id (uuid)','clientaccount','client account','clienteaccount','cuenta cliente'].includes(s)) return 'clientAccount';
          if (['clientname','client name','client name (nombre)','nombrecliente','nombre cliente','cliente','cliente nombre'].includes(s)) return 'clientAccountName';
          if (['clientlastname','client last name','apellido','apellidocliente','apellido cliente','client last','client_lastname'].includes(s)) return 'clientAccountLastName';
          if (['clientemail','client email','emailcliente','clienteemail','correo','correo cliente','correo_cliente'].includes(s)) return 'clientEmail';
          if (['clientphone','client phone','telefono cliente','telefono_cliente','client_phone'].includes(s)) return 'clientPhone';

          // Site / business info
          if (['sitename','site name','sitio','nombre sitio','nombresitio','nombre_sitio','companyname','company name','company','nombre empresa','empresa','razon social','razon_social','razonsocial'].includes(s)) return 'companyName';
          if (['address','direccion','dirección','direccion1','direccion principal','direccion_1'].includes(s)) return 'address';
          if (['secondaddress','second address','address2','direccion2','direccion secundaria','direccion_complemento','direccion complementaria'].includes(s)) return 'secondAddress';
          if (['postalcode','postal code','codigo postal','código postal','postal_code','postal'].includes(s)) return 'postalCode';
          if (['city','ciudad'].includes(s)) return 'city';
          if (['country','pais','país'].includes(s)) return 'country';
          if (['contactphone','contact phone','telefono','telefono contacto','telefono_contacto','contact_phone'].includes(s)) return 'contactPhone';
          if (['contactemail','contact email','correo contacto','correo_contacto','emailcontacto','contact_email'].includes(s)) return 'contactEmail';
          if (['description','descripcion','descripción','notes','notas'].includes(s)) return 'description';
          if (['latitude','latitud','lat'].includes(s)) return 'latitude';
          if (['longitude','longitud','lng','lon'].includes(s)) return 'longitude';
          if (['categoryids','categories','categorias','categoriaids','categoría','categorias'].includes(s)) return 'categoryIds';
          if (['importhash','import hash','import_hash'].includes(s)) return 'importHash';

          return null;
        };

        // Read header row
        const headerRow = worksheet.getRow(1);
        for (let c = 1; c <= headerRow.cellCount; c++) {
          const hv = extractValue(headerRow.getCell(c).value);
          const mapped = mapHeader(hv);
          if (mapped) headerMap[c] = mapped;
        }

        console.log('📥 Import headerMap:', headerMap);

        worksheet.eachRow((row, rowNumber) => {
          if (rowNumber === 1) return; // header

          const values = row.values;

          const rowData: any = { active: true };
          let clientAccountRaw = '';

          for (let c = 1; c <= row.cellCount; c++) {
            const key = headerMap[c];
            if (!key) continue;
            const val = extractValue(values[c]);
            if (!val) continue;

            if (key === 'clientAccount') {
              clientAccountRaw = val;
            } else if (key === 'clientAccountName') {
              rowData.clientAccountName = val;
            } else if (key === 'clientAccountLastName') {
              rowData.clientAccountLastName = val;
            } else if (key === 'clientPhone') {
              rowData.clientPhone = val;
            } else if (key === 'clientEmail') {
              rowData.clientEmail = val;
            } else if (key === 'companyName') {
              rowData.companyName = val;
            } else if (key === 'description') {
              rowData.description = val;
            } else if (key === 'contactPhone') {
              rowData.contactPhone = val;
            } else if (key === 'contactEmail') {
              rowData.contactEmail = val;
            } else if (key === 'address') {
              rowData.address = val;
            } else if (key === 'secondAddress') {
              rowData.secondAddress = val;
              rowData.addressComplement = val;
            } else if (key === 'postalCode') {
              rowData.postalCode = val;
            } else if (key === 'city') {
              rowData.city = val;
            } else if (key === 'country') {
              rowData.country = val;
            } else if (key === 'categoryIds') {
              rowData.categoryIds = val;
            } else if (key === 'importHash') {
              rowData.importHash = val;
            }
            // latitude/longitude intentionally ignored (not stored)
          }

          // Required fields per UI: Cliente, Sitio de publicación (companyName), Dirección,
          // Código postal, Ciudad, País, Número de Teléfono, Correo Electrónico, Descripción
          const missing: string[] = [];

          console.log(`📥 Row ${rowNumber} parsed before validation:`, { rowData, clientAccountRaw });

          // Accept the provided clientAccount value as the clientAccountId
          if (clientAccountRaw) {
            rowData.clientAccountId = clientAccountRaw;
          }

          // Fallbacks: if companyName is missing, try to use client name(s)
          if (!rowData.companyName) {
            if (rowData.clientAccountName && rowData.clientAccountLastName) {
              rowData.companyName = `${rowData.clientAccountName} ${rowData.clientAccountLastName}`;
            } else if (rowData.clientAccountName) {
              rowData.companyName = rowData.clientAccountName;
            }
          }

          // If contactPhone missing, fallback to clientPhone
          if (!rowData.contactPhone && rowData.clientPhone) {
            rowData.contactPhone = rowData.clientPhone;
          }

          if (!rowData.clientAccountId) missing.push('clientAccount (clientId requerido)');
          if (!rowData.companyName) missing.push('companyName');
          if (!rowData.description) missing.push('description');
          if (!rowData.contactPhone) missing.push('contactPhone');
          if (!rowData.contactEmail) missing.push('contactEmail');
          if (!rowData.address) missing.push('address');
          if (!rowData.postalCode) missing.push('postalCode');
          if (!rowData.city) missing.push('city');
          if (!rowData.country) missing.push('country');

          if (missing.length === 0) {
            // Normalize categoryIds to array if present
            data.push(rowData);
          } else {
            console.log(`⛔ Fila ${rowNumber} omitida. Faltan campos: ${missing.join(', ')}`);
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
