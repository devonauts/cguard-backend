import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import ClientAccountService from '../../services/clientAccountService';
import multer from 'multer';

// Configurar multer para manejar archivos en memoria
const upload = multer({ storage: multer.memoryStorage() });

export default [
  upload.single('file'), // Middleware de multer para procesar el archivo
  async (req, res, next) => {
    try {
      new PermissionChecker(req).validateHas(
        Permissions.values.clientAccountImport,
      );

      console.log('🔍 DEBUG: req.file =', req.file);
      console.log('🔍 DEBUG: req.body =', req.body);

      let data = req.body.data;
      
      // Si no viene data pero viene un archivo, parsearlo
      if (!data && req.file) {
        const ExcelJS = require('exceljs');
        const workbook = new ExcelJS.Workbook();
        
        // El archivo viene en req.file.buffer
        await workbook.xlsx.load(req.file.buffer);
        
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

