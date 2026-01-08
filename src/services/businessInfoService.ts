import Error400 from '../errors/Error400';
import SequelizeRepository from '../database/repositories/sequelizeRepository';
import { IServiceOptions } from './IServiceOptions';
import BusinessInfoRepository from '../database/repositories/businessInfoRepository';
import ClientAccountRepository from '../database/repositories/clientAccountRepository';
import TenantUserRepository from '../database/repositories/tenantUserRepository';
import Roles from '../security/roles';
import crypto from 'crypto';

export default class BusinessInfoService {
  options: IServiceOptions;

  constructor(options) {
    this.options = options;
  }

  async create(data) {
    const transaction = await SequelizeRepository.createTransaction(
      this.options.database,
    );

    try {

      // If a clientAccountId is provided, ensure it belongs to the tenant
      if (data && data.clientAccountId) {
        data.clientAccountId = await ClientAccountRepository.filterIdInTenant(
          data.clientAccountId,
          { ...this.options, transaction },
        );
      }


      const record = await BusinessInfoRepository.create(data, {
        ...this.options,
        transaction,
      });

      // If the creator is not admin, auto-assign the created post site and optionally the client to that tenant user.
      try {
        const currentUser = this.options.currentUser;
        const currentTenant = this.options.currentTenant;

        if (currentUser && currentTenant) {
          console.debug('Auto-assign post site - preparing to assign', {
            tenantId: currentTenant.id,
            userId: currentUser.id,
            postSiteId: record.id,
            clientAccountId: data && data.clientAccountId,
          });

            // Determine tenant roles for the current user to avoid passing undefined
            const tenantEntry = Array.isArray(currentUser.tenants)
              ? currentUser.tenants.find(
                  (t) => t && t.tenant && String(t.tenant.id) === String(currentTenant.id),
                )
              : null;

            const rolesToPass = tenantEntry && Array.isArray(tenantEntry.roles) ? tenantEntry.roles : [];

            // If front provided a tenantUserId, prefer to insert the pivot row(s) directly for that tenantUser
            const providedTenantUserId = data && (data.tenantUserId || data.tenantUser || data.tenant_user_id);

            if (providedTenantUserId) {
              try {
                const tenantUserRec = await this.options.database.tenantUser.findOne({ where: { id: providedTenantUserId, tenantId: currentTenant.id }, transaction });
                if (tenantUserRec) {
                  const now = new Date();

                  // Insert post site pivot
                  const postRow = {
                    id: (crypto as any).randomUUID ? (crypto as any).randomUUID() : crypto.randomBytes(16).toString('hex'),
                    tenantUserId: providedTenantUserId,
                    businessInfoId: record.id,
                    createdAt: now,
                    updatedAt: now,
                  };
                  try {
                    console.debug('Auto-assign post site - inserting pivot row for providedTenantUserId', { postRow });
                    await this.options.database.sequelize.getQueryInterface().bulkInsert('tenant_user_post_sites', [postRow], { transaction });
                    console.debug('Auto-assign post site - pivot insert succeeded for providedTenantUserId', { tenantUserId: providedTenantUserId, postSiteId: record.id });
                  } catch (err) {
                    console.error('Auto-assign post site - pivot insert error (providedTenantUserId):', err);
                  }

                  // If clientAccountId provided, also insert client pivot
                  if (data && data.clientAccountId) {
                    const clientRow = {
                      id: (crypto as any).randomUUID ? (crypto as any).randomUUID() : crypto.randomBytes(16).toString('hex'),
                      tenantUserId: providedTenantUserId,
                      clientAccountId: data.clientAccountId,
                      createdAt: now,
                      updatedAt: now,
                    };
                    try {
                      console.debug('Auto-assign client (from post) - inserting pivot row for providedTenantUserId', { clientRow });
                      await this.options.database.sequelize.getQueryInterface().bulkInsert('tenant_user_client_accounts', [clientRow], { transaction });
                      console.debug('Auto-assign client (from post) - pivot insert succeeded for providedTenantUserId', { tenantUserId: providedTenantUserId, clientId: data.clientAccountId });
                    } catch (err) {
                      console.error('Auto-assign client (from post) - pivot insert error (providedTenantUserId):', err);
                    }
                  }
                } else {
                  console.debug('Auto-assign post site - provided tenantUserId not found or not in tenant', { providedTenantUserId, tenantId: currentTenant.id });
                }
              } catch (err) {
                console.error('Auto-assign post site - error validating providedTenantUserId:', err);
              }
            } else {
              // Fallback to updateRoles when no tenantUserId provided
              await TenantUserRepository.updateRoles(
                currentTenant.id,
                currentUser.id,
                rolesToPass,
                { ...this.options, transaction, addRoles: true },
                data && data.clientAccountId ? [data.clientAccountId] : undefined,
                [record.id],
              );
            }

          console.debug('Auto-assign post site - updateRoles completed for', { postSiteId: record.id });
        }
      } catch (err) {
        console.error('Auto-assign post site to creator failed:', err);
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
        'businessInfo',
      );

      throw error;
    }
  }

  async update(id, data) {
    const transaction = await SequelizeRepository.createTransaction(
      this.options.database,
    );

    try {

      // If a clientAccountId is provided, ensure it belongs to the tenant
      if (data && data.clientAccountId) {
        data.clientAccountId = await ClientAccountRepository.filterIdInTenant(
          data.clientAccountId,
          { ...this.options, transaction },
        );
      }


      const record = await BusinessInfoRepository.update(
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
        'businessInfo',
      );

      throw error;
    }
  }

  async destroyAll(ids) {
    const transaction = await SequelizeRepository.createTransaction(
      this.options.database,
    );

    try {
      // Normalize incoming ids to an array so we accept:
      // - Array of ids
      // - JSON string like '["id1","id2"]'
      // - Comma-separated string 'id1,id2'
      // - Object with numeric keys (from some querystring parsers)
      let idsArray: any[] = [];

      if (!ids) {
        idsArray = [];
      } else if (Array.isArray(ids)) {
        idsArray = ids;
      } else if (typeof ids === 'string') {
        const raw = ids.trim();
        try {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) {
            idsArray = parsed;
          } else if (typeof parsed === 'string') {
            idsArray = parsed.split(',').map((s) => s.trim()).filter(Boolean);
          } else {
            idsArray = [parsed];
          }
        } catch (err) {
          idsArray = raw.split(',').map((s) => s.trim()).filter(Boolean);
        }
      } else if (typeof ids === 'object') {
        try {
          // If it's array-like (has length), convert to array
          if (typeof (ids as any).length === 'number') {
            idsArray = Array.from(ids as any);
          } else {
            idsArray = Object.values(ids as any).map(String);
          }
        } catch (err) {
          idsArray = [];
        }
      } else {
        idsArray = [ids];
      }

      for (const id of idsArray) {
        await BusinessInfoRepository.destroy(id, {
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
    return BusinessInfoRepository.findById(id, this.options);
  }

  async findAllAutocomplete(search, limit) {
    return BusinessInfoRepository.findAllAutocomplete(
      search,
      limit,
      this.options,
    );
  }

  async findAndCountAll(args) {
    return BusinessInfoRepository.findAndCountAll(
      args,
      this.options,
    );
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
        if (await this._isImportHashExistent(importHash)) {
          results.skipped++;
          results.errors.push({ row: i + 1, name: data.companyName, error: 'Este registro ya fue importado previamente' });
          continue;
        }

        // Normalize CSV/Front field names to internal fields
        // Accept both the backend template and the frontend CSV headers.
        if (data.clientId && !data.clientAccountId) {
          data.clientAccountId = data.clientId;
        }

        if (data.clientName && !data.clientAccountName) {
          data.clientAccountName = data.clientName;
        }

        if (data.clientEmail && !data.clientEmail) {
          // redundant guard but keep the field available for client creation
          data.clientEmail = data.clientEmail;
        }

        if (data.siteName && !data.companyName) {
          data.companyName = data.siteName;
        }

        if (data.secondAddress && !data.addressComplement) {
          data.addressComplement = data.secondAddress;
        }

        // categoryIds: accept CSV as JSON string or comma/semicolon separated
        if (data.categoryIds && !Array.isArray(data.categoryIds)) {
          const raw = String(data.categoryIds).trim();
          try {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) {
              data.categoryIds = parsed;
            } else if (typeof parsed === 'string') {
              data.categoryIds = parsed.split(/[,;|]/).map((s) => s.trim()).filter(Boolean);
            }
          } catch (err) {
            data.categoryIds = raw.split(/[,;|]/).map((s) => s.trim()).filter(Boolean);
          }
        }

        // Keep clientEmail/contactEmail for possible client creation
        if (!data.clientEmail && data.contactEmail) {
          data.clientEmail = data.contactEmail;
        }

        // Basic validation: required fields per UI
        const missingFields: string[] = [];
        if (!data.clientAccountId && !data.clientAccountName) missingFields.push('clientAccount');
        if (!data.companyName) missingFields.push('companyName');
        if (!data.description) missingFields.push('description');
        if (!data.contactPhone) missingFields.push('contactPhone');
        if (!data.contactEmail) missingFields.push('contactEmail');
        if (!data.address) missingFields.push('address');
        if (!data.postalCode) missingFields.push('postalCode');
        if (!data.city) missingFields.push('city');
        if (!data.country) missingFields.push('country');

        if (missingFields.length > 0) {
          results.failed++;
          results.errors.push({ row: i + 1, name: data.companyName, error: `Campos obligatorios faltantes: ${missingFields.join(', ')}` });
          continue;
        }

        const dataToCreate = {
          ...data,
          importHash,
        };

        // If clientAccountName was provided (not an id), try to resolve it to an id
        if (dataToCreate.clientAccountName && !dataToCreate.clientAccountId) {
          try {
            const matches = await ClientAccountRepository.findAllAutocomplete(
              dataToCreate.clientAccountName,
              1,
              this.options,
            );
            if (matches && matches.length > 0) {
              dataToCreate.clientAccountId = matches[0].id;
            }
          } catch (err) {
            // resolution failed silently; creation will proceed without clientAccountId
            console.log('⚠️ No se pudo resolver clientAccountName a id:', dataToCreate.clientAccountName);
          }
        }

        await this.create(dataToCreate);
        results.success++;
      } catch (error) {
        results.failed++;
        results.errors.push({ row: i + 1, name: data.companyName, error: error instanceof Error ? error.message : 'Error desconocido' });
      }
    }

    return results;
  }

  async exportToFile(format, filter = {}) {
    const { rows } = await BusinessInfoRepository.findAndCountAll(
      { filter, limit: 0, offset: 0, orderBy: 'companyName_ASC' },
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

  async _generatePDF(rows) {
    const PDFDocument = require('pdfkit');

    return new Promise((resolve, reject) => {
      try {
        const doc = new PDFDocument({ margin: 30, size: 'A3', layout: 'landscape', bufferPages: true });
        const chunks: Buffer[] = [];

        doc.on('data', (chunk) => chunks.push(chunk));
        doc.on('end', () => resolve(Buffer.concat(chunks)));

        const pageWidth = doc.page.width;
        const pageHeight = doc.page.height;
        const marginLeft = 30;
        const marginRight = 30;
        const usableWidth = pageWidth - marginLeft - marginRight;

        doc.fontSize(24).font('Helvetica-Bold').text('Lista de Business Info', marginLeft, 30, { width: usableWidth, align: 'center' });
        doc.fontSize(11).font('Helvetica').text(`Fecha: ${new Date().toLocaleDateString()}`, marginLeft, 60, { width: usableWidth, align: 'right' });

        const tableTop = 85;
        const fontSize = 9;
        doc.fontSize(fontSize).font('Helvetica-Bold');

        const cols = [
          { label: 'Nombre', width: usableWidth * 0.18 },
          { label: 'Cliente', width: usableWidth * 0.15 },
          { label: 'Email', width: usableWidth * 0.16 },
          { label: 'Teléfono', width: usableWidth * 0.12 },
          { label: 'Dirección', width: usableWidth * 0.20 },
          { label: 'Ciudad', width: usableWidth * 0.09 },
          { label: 'País', width: usableWidth * 0.06 },
          { label: 'Estado', width: usableWidth * 0.04 },
        ];

        let x = marginLeft;
        cols.forEach((col) => {
          doc.text(col.label, x, tableTop, { width: col.width, align: 'left', lineBreak: false });
          x += col.width;
        });

        const lineY = tableTop + 15;
        doc.moveTo(marginLeft, lineY).lineTo(pageWidth - marginRight, lineY).stroke();

        const firstRowY = lineY + 10;
        doc.font('Helvetica');
        let currentY = firstRowY;

        rows.forEach((row) => {
          if (currentY > pageHeight - 80) {
            doc.addPage();
            currentY = 40;
            doc.fontSize(fontSize).font('Helvetica-Bold');
            let xh = marginLeft;
            cols.forEach((col) => {
              doc.text(col.label, xh, currentY, { width: col.width, align: 'left', lineBreak: false });
              xh += col.width;
            });
            currentY += 20;
            doc.font('Helvetica');
          }

          let xx = marginLeft;
          doc.text(row.companyName || '', xx, currentY, { width: cols[0].width });
          xx += cols[0].width;
          doc.text(row.clientAccountName || '', xx, currentY, { width: cols[1].width });
          xx += cols[1].width;
          doc.text(row.contactEmail || '', xx, currentY, { width: cols[2].width });
          xx += cols[2].width;
          doc.text(row.contactPhone || '', xx, currentY, { width: cols[3].width });
          xx += cols[3].width;
          doc.text(row.address || '', xx, currentY, { width: cols[4].width });
          xx += cols[4].width;
          doc.text(row.city || '', xx, currentY, { width: cols[5].width });
          xx += cols[5].width;
          doc.text(row.country || '', xx, currentY, { width: cols[6].width });
          xx += cols[6].width;
          const status = row.active === false || row.active === 'false' ? 'Archivado' : 'Activo';
          doc.text(status, xx, currentY, { width: cols[7].width });

          currentY += 18;
        });

        doc.end();
      } catch (error) {
        reject(error);
      }
    });
  }

  async _generateExcel(rows) {
    const ExcelJS = require('exceljs');

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('BusinessInfos');

    worksheet.mergeCells('A1:E1');
    const titleCell = worksheet.getCell('A1');
    titleCell.value = 'Lista de Business Info';
    titleCell.font = { bold: true, size: 16 };
    titleCell.alignment = { vertical: 'middle', horizontal: 'center' };

    worksheet.mergeCells('A2:E2');
    const dateCell = worksheet.getCell('A2');
    dateCell.value = `Fecha: ${new Date().toLocaleDateString()}`;
    dateCell.alignment = { vertical: 'middle', horizontal: 'right' };

    worksheet.getRow(3).height = 5;

    const headerRow = worksheet.getRow(4);
    const headers = ['Nombre', 'Cliente', 'Email', 'Teléfono', 'Dirección', 'Ciudad', 'País', 'Estado'];
    const widths = [30, 25, 30, 20, 50, 18, 12, 10];

    headers.forEach((header, index) => {
      const cell = headerRow.getCell(index + 1);
      cell.value = header;
      cell.font = { bold: true };
      worksheet.getColumn(index + 1).width = widths[index];
    });

    let currentRow = 5;
    rows.forEach((r) => {
      const row = worksheet.getRow(currentRow);
      const status = r.active === false || r.active === 'false' ? 'Archivado' : 'Activo';
      row.values = [
        r.companyName || '',
        r.clientAccountName || '',
        r.contactEmail || '',
        r.contactPhone || '',
        r.address || '',
        r.city || '',
        r.country || '',
        status,
      ];
      currentRow++;
    });

    return await workbook.xlsx.writeBuffer();
  }

  async import(data, importHash) {
    if (!importHash) {
      throw new Error400(
        this.options.language,
        'importer.errors.importHashRequired',
      );
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

  async _isImportHashExistent(importHash) {
    const count = await BusinessInfoRepository.count(
      {
        importHash,
      },
      this.options,
    );

    return count > 0;
  }
}
