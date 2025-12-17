import Error400 from '../errors/Error400';
import SequelizeRepository from '../database/repositories/sequelizeRepository';
import { IServiceOptions } from './IServiceOptions';
import BusinessInfoRepository from '../database/repositories/businessInfoRepository';
import ClientAccountRepository from '../database/repositories/clientAccountRepository';

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
      for (const id of ids) {
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

        // Basic validation: companyName and address required
        if (!data.companyName || !data.address) {
          results.failed++;
          results.errors.push({ row: i + 1, name: data.companyName, error: 'Campos obligatorios faltantes' });
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
          { label: 'Nombre', width: usableWidth * 0.2 },
          { label: 'Email', width: usableWidth * 0.2 },
          { label: 'Teléfono', width: usableWidth * 0.15 },
          { label: 'Dirección', width: usableWidth * 0.25 },
          { label: 'Ciudad', width: usableWidth * 0.1 },
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
          doc.text(row.contactEmail || '', xx, currentY, { width: cols[1].width });
          xx += cols[1].width;
          doc.text(row.contactPhone || '', xx, currentY, { width: cols[2].width });
          xx += cols[2].width;
          doc.text(row.address || '', xx, currentY, { width: cols[3].width });
          xx += cols[3].width;
          doc.text(row.city || '', xx, currentY, { width: cols[4].width });

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
    const headers = ['Nombre', 'Email', 'Teléfono', 'Dirección', 'Ciudad'];
    const widths = [40, 35, 25, 50, 20];

    headers.forEach((header, index) => {
      const cell = headerRow.getCell(index + 1);
      cell.value = header;
      cell.font = { bold: true };
      worksheet.getColumn(index + 1).width = widths[index];
    });

    let currentRow = 5;
    rows.forEach((r) => {
      const row = worksheet.getRow(currentRow);
      row.values = [r.companyName || '', r.contactEmail || '', r.contactPhone || '', r.address || '', r.city || ''];
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
