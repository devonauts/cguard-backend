import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import ClientAccountService from '../../services/clientAccountService';
import multer from 'multer';

// NOTE: A top-level multipart parser is applied in the API index for
// endpoints ending with `/import`. To avoid parsing the multipart stream
// twice (which causes busboy `Unexpected end of form`), we do not attach
// another multer middleware here. Instead, the handler will normalize the
// incoming file from either `req.file` or `req.files`.
export default [
  async (req, res, next) => {
    try {
      new PermissionChecker(req).validateHas(
        Permissions.values.clientAccountImport,
      );

      // Normalize file: support either req.file (route-level) or req.files (global parser)
      let incomingFile: any = (req as any).file;
      if (!incomingFile && Array.isArray((req as any).files) && (req as any).files.length > 0) {
        const filesArray = (req as any).files as any[];
        incomingFile = filesArray.find(f => f.fieldname === 'file') || filesArray[0];
      }

      console.log('🔍 DEBUG: req.file =', incomingFile);
      console.log('🔍 DEBUG: req.body =', req.body);

      let data = req.body.data;

      // Si no viene data pero viene un archivo, parsearlo
      if (!data && incomingFile) {
        const ExcelJS = require('exceljs');
        const workbook = new ExcelJS.Workbook();

        // El archivo viene en req.file.buffer
        // Soportar tanto .xlsx como .csv: si el nombre termina en .csv, leer como CSV
        try {
          const name = (incomingFile.originalname || '').toString();
          const lowerName = name.toLowerCase();
          console.log('🔍 clientAccountImport: file info ->', { originalname: name, mimetype: incomingFile.mimetype, size: incomingFile.size || (incomingFile.buffer && incomingFile.buffer.length) });
          if (lowerName.endsWith('.csv') || (incomingFile.mimetype || '').includes('csv')) {
            // Log a snippet of the buffer as UTF-8 to help debugging encoding issues
            try {
              const sample = incomingFile.buffer.toString('utf8', 0, Math.min(1024, incomingFile.buffer.length));
              console.log('🔍 clientAccountImport: CSV sample (first 1024 chars) ->', sample.replace(/\r\n/g, '\\n').slice(0, 1024));
            } catch (e) {
              console.warn('🔍 clientAccountImport: could not stringify buffer sample', e && e.message ? e.message : e);
            }

            // Crear stream a partir del buffer para que ExcelJS pueda leer CSV
            const { Readable } = require('stream');
            const rs = new Readable();
            rs.push(incomingFile.buffer);
            rs.push(null);
            // ExcelJS soporta lectura CSV desde stream
            // Esto creará una worksheet con los datos del CSV
            try {
              await workbook.csv.read(rs);
            } catch (errCsv) {
              console.warn('🔍 clientAccountImport: workbook.csv.read failed', errCsv && errCsv.message ? errCsv.message : errCsv);
              throw errCsv;
            }
          } else {
            await workbook.xlsx.load(incomingFile.buffer);
          }
        } catch (e) {
          console.warn('clientAccountImport: ExcelJS read failed, attempting xlsx.load fallback', e && e.message ? e.message : e);
          // Fallback intentar como xlsx
          try {
            await workbook.xlsx.load(incomingFile.buffer);
          } catch (e2) {
            console.error('clientAccountImport: xlsx.load fallback also failed', e2 && e2.message ? e2.message : e2);
            throw e2;
          }
        }
        
        console.log('📚 Worksheets:', workbook.worksheets.map(ws => ws.name));
        console.log('📄 Total worksheets:', workbook.worksheets.length);
        
        const worksheet = workbook.getWorksheet(1);
        console.log('📄 Worksheet seleccionado:', worksheet?.name);
        console.log('📄 Total de filas:', worksheet?.rowCount);
        console.log('📄 Actual row count:', worksheet?.actualRowCount);
        
        data = [];
        
        // Función helper para extraer valor (maneja objetos con text, hyperlink, etc)
        const extractValue = (val: any): string => {
          if (!val) return '';
          if (typeof val === 'string') return val.trim();
          if (typeof val === 'number') return val.toString();
          if (val.text) return val.text.toString().trim();
          if (val.hyperlink) return val.hyperlink.toString().trim();
          return val.toString().trim();
        };

        // Saltar las primeras 4 filas (título, fecha, vacía, headers)
        let rowsProcessed = 0;
        worksheet.eachRow((row, rowNumber) => {
          rowsProcessed++;
          console.log(`📋 Procesando fila ${rowNumber} de ${worksheet.rowCount}`);
          
          const values = row.values as any[];
          console.log(`📋 Fila ${rowNumber} valores:`, values);
          
          // Headers están en fila 1, datos empiezan en fila 2
          if (rowNumber > 1) {
            // Detectar formato por cantidad de columnas
            // Formato frontend: 10 columnas (name, lastName, email, phoneNumber, address, addressLine2, zipCode, city, country)
            // Formato backend export: 12 columnas (+ faxNumber, website, categoryName)
            const name = extractValue(values[1]);
            const lastName = extractValue(values[2]);
            const email = extractValue(values[3]);
            const phoneNumber = extractValue(values[4]);
            const address = extractValue(values[5]);
            const addressComplement = extractValue(values[6]); // addressLine2 en frontend
            const zipCode = extractValue(values[7]);
            const city = extractValue(values[8]);
            const country = extractValue(values[9]);
            const faxNumber = extractValue(values[10]) || ''; // Opcional
            const website = extractValue(values[11]) || ''; // Opcional
            const categoryName = extractValue(values[12]) || ''; // Opcional
            
            console.log(`   ✅ name: "${name}" | lastName: "${lastName}" | email: "${email}" | address: "${address}"`);
            
            // Solo agregar si tiene nombre y dirección (campos obligatorios)
            if (name && address) {
              data.push({
                name,
                lastName: lastName || '',
                email: email || '',
                phoneNumber: phoneNumber || '',
                address,
                addressComplement: addressComplement || '',
                zipCode: zipCode || '',
                city: city || '',
                country: country || '',
                faxNumber: faxNumber,
                website: website,
                 active: true,
                // categoryId se puede buscar por nombre si es necesario
              });
            }
          }
        });
        
        console.log(`📊 Filas procesadas: ${rowsProcessed}`);
        console.log(`📊 Total de registros extraídos: ${data.length}`);
      }

      // Fallback: si no se extrajeron filas con ExcelJS pero el archivo parece CSV,
      // intentamos parsearlo manualmente desde el buffer como texto UTF-8.
      if ((Array.isArray(data) && data.length === 0) && incomingFile) {
        try {
          const name = (incomingFile.originalname || '').toString().toLowerCase();
          const looksLikeCsv = name.endsWith('.csv') || (incomingFile.mimetype || '').includes('csv') || (incomingFile.buffer && incomingFile.buffer.toString('utf8',0,16).includes(','));
          if (looksLikeCsv) {
            console.log('🔁 clientAccountImport: Attempting manual CSV parse fallback');
            const raw = incomingFile.buffer.toString('utf8');
            // Remove BOM if present
            const text = raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw;

            // Simple CSV parser that handles quoted fields
            function parseCSV(text: string) {
              const rows: string[][] = [];
              const re = /\s*(?:"([^"]*(?:""[^"]*)*)"|([^,]*))(?:,|\r?\n|$)/g;
              let row: string[] = [];
              let match: RegExpExecArray | null;
              let i = 0;
              while ((match = re.exec(text)) !== null) {
                const quoted = match[1];
                const bare = match[2];
                const val = quoted !== undefined ? quoted.replace(/""/g, '"') : (bare !== undefined ? bare : '');
                row.push(val);
                const sep = text[match.index + match[0].length - 1];
                if (sep === '\n' || sep === '\r' || re.lastIndex === text.length) {
                  rows.push(row);
                  row = [];
                }
                i++;
                // Prevent infinite loop
                if (i > 1000000) break;
              }
              // In case last row not pushed
              if (row.length) rows.push(row);
              return rows;
            }

            const rows = parseCSV(text);
            console.log('🔍 clientAccountImport: manual CSV parsed rows:', Math.min(rows.length, 5));
            if (rows.length > 1) {
              const headers = rows[0].map(h => (h || '').trim());
              for (let r = 1; r < rows.length; r++) {
                const vals = rows[r];
                const obj: any = {};
                for (let c = 0; c < headers.length; c++) {
                  const key = headers[c];
                  if (!key) continue;
                  obj[key] = vals[c] !== undefined ? vals[c] : '';
                }
                // Map known headers to expected fields
                const name = (obj['name'] || obj['Name'] || '').toString().trim();
                const address = (obj['address'] || obj['Address'] || '').toString().trim();
                if (name && address) {
                  data.push({
                    name,
                    lastName: (obj['lastName'] || obj['last_name'] || '').toString().trim(),
                    email: (obj['email'] || '').toString().trim(),
                    phoneNumber: (obj['phoneNumber'] || obj['phone'] || '').toString().trim(),
                    address,
                    addressComplement: (obj['addressLine2'] || obj['addressComplement'] || '').toString().trim(),
                    zipCode: (obj['zipCode'] || obj['postalCode'] || '').toString().trim(),
                    city: (obj['city'] || '').toString().trim(),
                    country: (obj['country'] || '').toString().trim(),
                    faxNumber: (obj['faxNumber'] || '').toString().trim(),
                    website: (obj['website'] || '').toString().trim(),
                    active: true,
                  });
                }
              }
              console.log(`🔍 clientAccountImport: manual CSV fallback extracted ${data.length} records`);
            }
          }
        } catch (e) {
          console.warn('🔍 clientAccountImport: manual CSV parse fallback failed', e && e.message ? e.message : e);
        }
      }
      
      // Si no hay datos válidos
      if (!data || (Array.isArray(data) && data.length === 0)) {
        return await ApiResponseHandler.error(req, res, {
          message: 'No se encontraron datos válidos para importar',
        });
      }
      
      // Si no viene importHash, generar uno automáticamente
      const importHash = req.body.importHash || `import_${Date.now()}_${Math.random().toString(36).substring(7)}`;

      let payload;

      // Si data es un array, importar múltiples registros
      if (Array.isArray(data)) {
        payload = await new ClientAccountService(req).importMultiple(
          data,
          importHash,
        );
        
        // Agregar mensaje de éxito con detalles
        const responsePayload = {
          ...payload,
          message: `Importación completada: ${payload.success} registros importados exitosamente${payload.skipped > 0 ? `, ${payload.skipped} omitidos` : ''}${payload.failed > 0 ? `, ${payload.failed} fallidos` : ''}`,
        };
        
        await ApiResponseHandler.success(req, res, responsePayload);
      } else {
        // Importar un solo registro
        payload = await new ClientAccountService(req).import(
          data,
          importHash,
        );
        
        await ApiResponseHandler.success(req, res, {
          ...payload,
          message: 'Cliente importado exitosamente',
        });
      }
    } catch (error) {
      await ApiResponseHandler.error(req, res, error);
    }
  }
];

