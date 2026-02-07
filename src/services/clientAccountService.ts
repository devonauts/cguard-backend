import Error400 from '../errors/Error400';
import SequelizeRepository from '../database/repositories/sequelizeRepository';
import { IServiceOptions } from './IServiceOptions';
import ClientAccountRepository from '../database/repositories/clientAccountRepository';
import TenantUserRepository from '../database/repositories/tenantUserRepository';
import Roles from '../security/roles';
import crypto from 'crypto';

export default class ClientAccountService {
  options: IServiceOptions;

  constructor(options) {
    this.options = options;
  }

  async create(data) {
    const transaction = await SequelizeRepository.createTransaction(
      this.options.database,
    );

    try {
      // No relationship filtering needed for simplified model
      const record = await ClientAccountRepository.create(data, {
        ...this.options,
        transaction,
      });

      // If the creator is not an admin, auto-assign the created client to that tenant user.
      try {
        const currentUser = this.options.currentUser;
        const currentTenant = this.options.currentTenant;

        if (currentUser && currentTenant) {
          console.debug('Auto-assign client - preparing to assign', {
            tenantId: currentTenant.id,
            userId: currentUser.id,
            clientId: record.id,
          });

          // Determine tenant roles for the current user to avoid passing undefined
          const tenantEntry = Array.isArray(currentUser.tenants)
            ? currentUser.tenants.find(
                (t) => t && t.tenant && String(t.tenant.id) === String(currentTenant.id),
              )
            : null;

          const rolesToPass = tenantEntry && Array.isArray(tenantEntry.roles) ? tenantEntry.roles : [];

          // If front provided a tenantUserId, prefer to insert the pivot row directly for that tenantUser
          const providedTenantUserId = data && (data.tenantUserId || data.tenantUser || data.tenant_user_id);

          if (providedTenantUserId) {
            try {
              // Validate tenantUser exists and belongs to current tenant
              const tenantUserRec = await this.options.database.tenantUser.findOne({ where: { id: providedTenantUserId, tenantId: currentTenant.id }, transaction });
              if (tenantUserRec) {
                const now = new Date();
                const pivotRow = {
                  id: (crypto as any).randomUUID ? (crypto as any).randomUUID() : crypto.randomBytes(16).toString('hex'),
                  tenantUserId: providedTenantUserId,
                  clientAccountId: record.id,
                  securityGuardId: data && data.securityGuardId ? data.securityGuardId : null, // Add securityGuardId if provided
                  createdAt: now,
                  updatedAt: now,
                };
                console.debug('Auto-assign client - inserting pivot row for providedTenantUserId', { pivotRow });
                try {
                  await this.options.database.sequelize.getQueryInterface().bulkInsert('tenant_user_client_accounts', [pivotRow], { transaction });
                  console.debug('Auto-assign client - pivot insert succeeded for providedTenantUserId', { tenantUserId: providedTenantUserId, clientId: record.id });
                } catch (err) {
                  // ignore duplicate insert errors
                  console.error('Auto-assign client - pivot insert error (providedTenantUserId):', err);
                }
              } else {
                console.debug('Auto-assign client - provided tenantUserId not found or not in tenant', { providedTenantUserId, tenantId: currentTenant.id });
              }
            } catch (err) {
              console.error('Auto-assign client - error validating providedTenantUserId:', err);
            }
          } else {
            await TenantUserRepository.updateRoles(
              currentTenant.id,
              currentUser.id,
              rolesToPass,
              { ...this.options, transaction, addRoles: true },
              [record.id],
              undefined,
              data && data.securityGuardId ? data.securityGuardId : undefined, // Pass securityGuardId if provided
            );
          }

          console.debug('Auto-assign client - updateRoles completed for', { clientId: record.id });
        }
      } catch (err) {
        // Log but don't block client creation if assignment fails
        console.error('Auto-assign client to creator failed:', err);
      }

      await SequelizeRepository.commitTransaction(
        transaction,
      );

      return record;
    } catch (error) {
      await SequelizeRepository.rollbackTransaction(
        transaction,
      );

      SequelizeRepository.handleUniqueFieldError(
        error,
        this.options.language,
        'clientAccount',
      );

      throw error;
    }
  }

  async update(id, data) {
    const transaction = await SequelizeRepository.createTransaction(
      this.options.database,
    );

    try {
      // No relationship filtering needed for simplified model
      const record = await ClientAccountRepository.update(
        id,
        data,
        {
          ...this.options,
          transaction,
        },
      );

      await SequelizeRepository.commitTransaction(
        transaction,
      );

      return record;
    } catch (error) {
      await SequelizeRepository.rollbackTransaction(
        transaction,
      );

      SequelizeRepository.handleUniqueFieldError(
        error,
        this.options.language,
        'clientAccount',
      );

      throw error;
    }
  }

  async destroyAll(ids) {
    const transaction = await SequelizeRepository.createTransaction(
      this.options.database,
    );

    try {
      for (const id of ids) {
        await ClientAccountRepository.destroy(id, {
          ...this.options,
          transaction,
        });
      }

      await SequelizeRepository.commitTransaction(
        transaction,
      );
    } catch (error) {
      await SequelizeRepository.rollbackTransaction(
        transaction,
      );
      throw error;
    }
  }

  async findById(id) {
    return ClientAccountRepository.findById(id, this.options);
  }

  async findAllAutocomplete(search, limit) {
    return ClientAccountRepository.findAllAutocomplete(
      search,
      limit,
      this.options,
    );
  }

  async findAndCountAll(args) {
    return ClientAccountRepository.findAndCountAll(
      args,
      this.options,
    );
  }

  async import(data, importHash) {
    // Si no viene importHash, generar uno automáticamente
    if (!importHash) {
      importHash = `import_${Date.now()}_${Math.random().toString(36).substring(7)}`;
    }

    if (await this._isImportHashExistent(importHash)) {
      throw new Error400(
        this.options.language,
        'importer.errors.importHashExistent',
      );
    }

    const dataToCreate = {
      ...data,
      importHash,
    };

    return this.create(dataToCreate);
  }

  async importMultiple(dataArray, importHashBase) {
    const results = {
      success: 0,
      failed: 0,
      skipped: 0,
      errors: [] as Array<{ row: number; error: string; name?: string }>,
    };

    for (let i = 0; i < dataArray.length; i++) {
      const data = dataArray[i];
      const importHash = `${importHashBase}_${i}`;

      try {
        // Verificar si ya existe por importHash
        if (await this._isImportHashExistent(importHash)) {
          results.skipped++;
          results.errors.push({
            row: i + 1,
            name: data.name,
            error: 'Este registro ya fue importado previamente',
          });
          continue;
        }

        // Verificar si ya existe un cliente con el mismo nombre
        const existingByName = await this._clientExistsByName(data.name);
        if (existingByName) {
          results.skipped++;
          results.errors.push({
            row: i + 1,
            name: data.name,
            error: 'Ya existe un cliente con este nombre',
          });
          continue;
        }

        const dataToCreate = {
          ...data,
          importHash,
        };

        await this.create(dataToCreate);
        results.success++;
      } catch (error) {
        results.failed++;
        results.errors.push({
          row: i + 1,
          name: data.name,
          error: error instanceof Error ? error.message : 'Error desconocido',
        });
      }
    }

    return results;
  }

  async _clientExistsByName(name) {
    const count = await ClientAccountRepository.count(
      {
        name,
      },
      this.options,
    );

    return count > 0;
  }

  async _isImportHashExistent(importHash) {
    const count = await ClientAccountRepository.count(
      {
        importHash,
      },
      this.options,
    );

    return count > 0;
  }

  async exportToFile(format, filter = {}) {
    const { rows } = await ClientAccountRepository.findAndCountAll(
      { filter, limit: 0, offset: 0, orderBy: 'name_ASC' },
      this.options,
    );

    if (format === 'pdf') {
      return this._generatePDF(rows);
    } else if (format === 'excel') {
      return this._generateExcel(rows);
    }

    throw new Error400(
      this.options.language,
      'Formato no soportado',
    );
  }

  async _generatePDF(clients) {
    const PDFDocument = require('pdfkit');
    
    return new Promise((resolve, reject) => {
      try {
        const doc = new PDFDocument({ 
          margin: 30,
          size: 'A3',
          layout: 'landscape',
          bufferPages: true,
        });
        const chunks: Buffer[] = [];

        doc.on('data', chunk => chunks.push(chunk));
        doc.on('end', () => resolve(Buffer.concat(chunks)));

        // Dimensiones de la página (A3 landscape)
        const pageWidth = doc.page.width;
        const pageHeight = doc.page.height;
        const marginLeft = 30;
        const marginRight = 30;
        const usableWidth = pageWidth - marginLeft - marginRight;

        // Header
        doc.fontSize(24).font('Helvetica-Bold').text('Lista de Clientes', marginLeft, 30, { 
          width: usableWidth,
          align: 'center' 
        });
        doc.fontSize(11).font('Helvetica').text(`Fecha: ${new Date().toLocaleDateString()}`, marginLeft, 60, {
          width: usableWidth,
          align: 'right' 
        });

        // Table Header
        const tableTop = 85;
        const fontSize = 9;
        doc.fontSize(fontSize).font('Helvetica-Bold');
        
        // Distribuir columnas uniformemente en el ancho disponible
        const colWidth = usableWidth / 13;
        const cols = [
          { label: 'Nombre', x: marginLeft, width: colWidth * 1.5 },
          { label: 'Apellidos', x: marginLeft + colWidth * 1.5, width: colWidth * 1.5 },
          { label: 'Email', x: marginLeft + colWidth * 3, width: colWidth * 1.5 },
          { label: 'Teléfono', x: marginLeft + colWidth * 4.5, width: colWidth },
          { label: 'Dirección', x: marginLeft + colWidth * 5.5, width: colWidth * 1.5 },
          { label: 'Dir. Comp.', x: marginLeft + colWidth * 7, width: colWidth },
          { label: 'CP', x: marginLeft + colWidth * 8, width: colWidth * 0.8 },
          { label: 'Ciudad', x: marginLeft + colWidth * 8.8, width: colWidth },
          { label: 'País', x: marginLeft + colWidth * 9.8, width: colWidth },
          { label: 'Fax', x: marginLeft + colWidth * 10.8, width: colWidth * 0.6 },
          { label: 'Categoría', x: marginLeft + colWidth * 11.4, width: colWidth * 0.6 },
          { label: 'Activo', x: marginLeft + colWidth * 12, width: colWidth * 0.6 },
        ];

        cols.forEach(col => {
          doc.text(col.label, col.x, tableTop, { width: col.width, align: 'left', lineBreak: false });
        });

        // Línea debajo del encabezado
        const lineY = tableTop + 15;
        doc.moveTo(marginLeft, lineY).lineTo(pageWidth - marginRight, lineY).stroke();
        
        // Establecer posición inicial para las filas de datos
        const firstRowY = lineY + 10;
        
        // Table Rows
        doc.font('Helvetica');
        let currentY = firstRowY;
        let currentPage = 1;
        
        clients.forEach((client, index) => {
          // Si no cabe en la página, agregar nueva página
          if (currentY > pageHeight - 80) {
            doc.addPage();
            currentPage++;
            currentY = 40;
            
            // Redibujar encabezados en nueva página
            doc.fontSize(fontSize).font('Helvetica-Bold');
            cols.forEach(col => {
              doc.text(col.label, col.x, currentY, { width: col.width, align: 'left', lineBreak: false });
            });
            doc.moveTo(marginLeft, currentY + 15).lineTo(pageWidth - marginRight, currentY + 15).stroke();
            currentY += 23;
            doc.font('Helvetica');
          }

          const rowData = [
            { text: client.name || '', x: marginLeft, width: colWidth * 1.5 },
            { text: client.lastName || '', x: marginLeft + colWidth * 1.5, width: colWidth * 1.5 },
            { text: client.email || '', x: marginLeft + colWidth * 3, width: colWidth * 1.5 },
            { text: client.phoneNumber || '', x: marginLeft + colWidth * 4.5, width: colWidth },
            { text: client.address || '', x: marginLeft + colWidth * 5.5, width: colWidth * 1.5 },
            { text: client.addressComplement || '', x: marginLeft + colWidth * 7, width: colWidth },
            { text: client.zipCode || '', x: marginLeft + colWidth * 8, width: colWidth * 0.8 },
            { text: client.city || '', x: marginLeft + colWidth * 8.8, width: colWidth },
            { text: client.country || '', x: marginLeft + colWidth * 9.8, width: colWidth },
            { text: client.faxNumber || '', x: marginLeft + colWidth * 10.8, width: colWidth * 0.6 },
            { text: client.category?.name || '-', x: marginLeft + colWidth * 11.4, width: colWidth * 0.6 },
            { text: (client.active ? 'true' : 'false'), x: marginLeft + colWidth * 12, width: colWidth * 0.6 },
          ];

          doc.fontSize(8);
          rowData.forEach(col => {
            doc.text(col.text, col.x, currentY, { width: col.width - 5, lineBreak: false, ellipsis: true });
          });

          currentY += 18;
        });

        // Agregar footer a TODAS las páginas al final
        const range = doc.bufferedPageRange();
        const totalPages = range.count;
        
        for (let i = 0; i < totalPages; i++) {
          // switchToPage usa índice desde range.start
          doc.switchToPage(range.start + i);
          
          // Dibujar footer en posición fija
          doc.fontSize(9).font('Helvetica');
          const footerText = `Página ${i + 1} de ${totalPages}`;
          const textWidth = doc.widthOfString(footerText);
          const footerX = marginLeft + (usableWidth - textWidth) / 2;
          const footerY = pageHeight - 30;
          
          doc.text(footerText, footerX, footerY, { 
            lineBreak: false,
            continued: false
          });
        }

        doc.end();
      } catch (error) {
        reject(error);
      }
    });
  }

  async _generateExcel(clients) {
    const ExcelJS = require('exceljs');
    
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Clientes');

    // Agregar título
    worksheet.mergeCells('A1:M1');
    const titleCell = worksheet.getCell('A1');
    titleCell.value = 'Lista de Clientes';
    titleCell.font = { bold: true, size: 16, color: { argb: 'FF000000' } };
    titleCell.alignment = { vertical: 'middle', horizontal: 'center' };
    titleCell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFE0E0E0' }
    };

    // Agregar fecha
    worksheet.mergeCells('A2:M2');
    const dateCell = worksheet.getCell('A2');
    dateCell.value = `Fecha: ${new Date().toLocaleDateString()}`;
    dateCell.font = { size: 11, color: { argb: 'FF000000' } };
    dateCell.alignment = { vertical: 'middle', horizontal: 'right' };

    // Agregar fila vacía
    worksheet.getRow(3).height = 5;

    // Add headers en la fila 4
    const headerRow = worksheet.getRow(4);
    const headers = ['Nombre', 'Apellidos', 'Email', 'Teléfono', 'Dirección', 'Dirección Complementaria', 'Código Postal', 'Ciudad', 'País', 'Fax', 'Sitio Web', 'Categoría', 'Activo'];
    const widths = [25, 25, 30, 20, 35, 30, 15, 20, 20, 20, 30, 25, 12];
    
    headers.forEach((header, index) => {
      const cell = headerRow.getCell(index + 1);
      cell.value = header;
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FF4472C4' }
      };
      cell.alignment = { vertical: 'middle', horizontal: 'center' };
      cell.border = {
        top: { style: 'thin' },
        left: { style: 'thin' },
        bottom: { style: 'thin' },
        right: { style: 'thin' }
      };
      
      // Set column width
      worksheet.getColumn(index + 1).width = widths[index];
    });

    // Add data starting from row 5
    let currentRow = 5;
    clients.forEach(client => {
      const row = worksheet.getRow(currentRow);
      row.values = [
        client.name || '',
        client.lastName || '',
        client.email || '',
        client.phoneNumber || '',
        client.address || '',
        client.addressComplement || '',
        client.zipCode || '',
        client.city || '',
        client.country || '',
        client.faxNumber || '',
        client.website || '',
        client.category?.name || '-',
        (client.active ? 'true' : 'false'),
      ];
      
      // Add borders to data cells
      row.eachCell((cell) => {
        cell.border = {
          top: { style: 'thin' },
          left: { style: 'thin' },
          bottom: { style: 'thin' },
          right: { style: 'thin' }
        };
      });
      
      currentRow++;
    });

    // Generate buffer
    return await workbook.xlsx.writeBuffer();
  }
}

