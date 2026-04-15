import Error400 from '../errors/Error400';
import SequelizeRepository from '../database/repositories/sequelizeRepository';
import { IServiceOptions } from './IServiceOptions';
import MemosRepository from '../database/repositories/memosRepository';
import SecurityGuardRepository from '../database/repositories/securityGuardRepository';

export default class MemosService {
  options: IServiceOptions;

  constructor(options) {
    this.options = options;
  }

  async create(data) {
    const transaction = await SequelizeRepository.createTransaction(
      this.options.database,
    );

    try {
      data.guardName = await SecurityGuardRepository.filterIdInTenant(data.guardName, { ...this.options, transaction });

      const record = await MemosRepository.create(data, {
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
        'memos',
      );

      throw error;
    }
  }

  async update(id, data) {
    const transaction = await SequelizeRepository.createTransaction(
      this.options.database,
    );

    try {
      data.guardName = await SecurityGuardRepository.filterIdInTenant(data.guardName, { ...this.options, transaction });

      const record = await MemosRepository.update(
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
        'memos',
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
        await MemosRepository.destroy(id, {
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
    return MemosRepository.findById(id, this.options);
  }

  async findAllAutocomplete(search, limit) {
    return MemosRepository.findAllAutocomplete(
      search,
      limit,
      this.options,
    );
  }

  async findAndCountAll(args) {
    return MemosRepository.findAndCountAll(
      args,
      this.options,
    );
  }

  async exportToFile(format, filter = {}) {
    const { rows } = await MemosRepository.findAndCountAll(
      { filter, limit: 0, offset: 0, orderBy: 'createdAt_DESC' },
      this.options,
    );

    if (format === 'pdf') {
      return this._generatePDF(rows);
    }

    if (format === 'excel') {
      return this._generateExcel(rows);
    }

    throw new Error400(
      this.options.language,
      'Formato no soportado',
    );
  }

  async _generatePDF(rows) {
    const PDFDocument = require('pdfkit');

    const formatDate = (value) => {
      if (!value) return '';
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return String(value);
      const pad = (n) => String(n).padStart(2, '0');
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
    };

    const normalizePerson = (person) => {
      if (!person) return '-';
      if (typeof person === 'string') return person;
      return person.fullName || person.name || person.guardName || person.username || person.email || '-';
    };

    return new Promise((resolve, reject) => {
      try {
        const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 30, bufferPages: true });
        const chunks: Buffer[] = [];

        doc.on('data', (chunk) => chunks.push(chunk));
        doc.on('end', () => resolve(Buffer.concat(chunks)));

        doc.font('Helvetica-Bold').fontSize(20).text('Listado de Memos', { align: 'center' });
        doc.moveDown(0.25);
        doc.fontSize(10).font('Helvetica').text(`Fecha de generación: ${formatDate(new Date().toISOString())}`, { align: 'right' });
        doc.moveDown(1);

        const pageWidth = doc.page.width;
        const pageHeight = doc.page.height;
        const margin = 20;
        const usableWidth = pageWidth - margin * 2;
        const columnWidths = [110, 120, 250, 70, 110, 110];
        const columns = ['Fecha', 'Asunto', 'Contenido', 'Estado', 'Guardia', 'Creado por'];
        const startX = margin;
        let currentY = doc.y;

        const drawRow = (cells: any[], options: { header?: boolean } = {}) => {
          const heights = cells.map((text, index) =>
            doc.heightOfString(String(text || '-'), { width: columnWidths[index], align: 'left' }),
          );
          const rowHeight = Math.max(...heights) + 8;

          if (currentY + rowHeight > pageHeight - margin) {
            doc.addPage();
            currentY = margin;
            drawHeader();
          }

          let x = startX;
          cells.forEach((text, index) => {
            const cellText = String(text || '-');
            if (options.header) {
              doc.rect(x, currentY, columnWidths[index], rowHeight).fillAndStroke('#F2F2F2', '#000000');
              doc.fillColor('#000000').font('Helvetica-Bold').fontSize(10).text(cellText, x + 4, currentY + 4, {
                width: columnWidths[index] - 8,
                align: 'left',
              });
            } else {
              doc.fillColor('#000000').font('Helvetica').fontSize(9).text(cellText, x + 4, currentY + 4, {
                width: columnWidths[index] - 8,
                align: 'left',
              });
              doc.rect(x, currentY, columnWidths[index], rowHeight).stroke();
            }
            x += columnWidths[index];
          });

          currentY += rowHeight;
        };

        const drawHeader = () => {
          drawRow(columns, { header: true });
        };

        drawHeader();

        rows.forEach((memo) => {
          const guardName = normalizePerson(memo.guardName);
          const createdByName = normalizePerson(memo.createdBy);
          const dateTime = formatDate(memo.dateTime);
          const status = memo.wasAccepted ? 'Aceptado' : 'Pendiente';

          drawRow([
            dateTime,
            memo.subject || '',
            memo.content || '',
            status,
            guardName,
            createdByName,
          ]);
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
    const worksheet = workbook.addWorksheet('Memos', {
      pageSetup: {
        orientation: 'landscape',
        margins: { left: 0.4, right: 0.4, top: 0.4, bottom: 0.4 },
      },
    });

    const formatDate = (value) => {
      if (!value) return '';
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return String(value);
      const pad = (n) => String(n).padStart(2, '0');
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
    };

    const normalizePerson = (person) => {
      if (!person) return '-';
      if (typeof person === 'string') return person;
      return person.fullName || person.name || person.guardName || person.username || person.email || '-';
    };

    worksheet.columns = [
      { width: 18 },
      { width: 28 },
      { width: 50 },
      { width: 16 },
      { width: 24 },
      { width: 24 },
    ];

    const titleRow = worksheet.addRow(['Listado de Memos', null, null, null, null, null]);
    worksheet.mergeCells(titleRow.number, 1, titleRow.number, 6);
    const titleCell = titleRow.getCell(1);
    titleCell.font = { name: 'Calibri', size: 18, bold: true };
    titleCell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: false };
    titleRow.height = 30;

    worksheet.addRow([null, null, null, null, null, null]);

    const dateRow = worksheet.addRow([`Fecha de generación: ${formatDate(new Date().toISOString())}`, null, null, null, null, null]);
    worksheet.mergeCells(dateRow.number, 1, dateRow.number, 6);
    const dateCell = dateRow.getCell(1);
    dateCell.alignment = { horizontal: 'right', vertical: 'middle', wrapText: false };
    dateRow.height = 18;

    worksheet.addRow([null, null, null, null, null, null]);

    const headerRow = worksheet.addRow(['Fecha', 'Asunto', 'Contenido', 'Estado', 'Guardia', 'Creado por']);
    headerRow.font = { bold: true };
    headerRow.alignment = { horizontal: 'center', vertical: 'middle' };
    headerRow.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFD9D9D9' },
    };

    rows.forEach((memo) => {
      const guardName = normalizePerson(memo.guardName);
      const createdByName = normalizePerson(memo.createdBy);
      const dateTime = formatDate(memo.dateTime);
      const status = memo.wasAccepted ? 'Aceptado' : 'Pendiente';

      worksheet.addRow([
        dateTime,
        memo.subject || '',
        memo.content || '',
        status,
        guardName,
        createdByName,
      ]);
    });

    worksheet.eachRow((row, rowNumber) => {
      if (rowNumber === titleRow.number) {
        row.height = 30;
        row.alignment = { horizontal: 'center', vertical: 'middle' };
        return;
      }

      if (rowNumber === dateRow.number) {
        row.alignment = { horizontal: 'right', vertical: 'middle' };
        return;
      }

      if (rowNumber === headerRow.number) {
        row.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
      } else {
        row.alignment = { vertical: 'top', wrapText: true };
      }

      if (rowNumber > headerRow.number) {
        row.height = 20;
      }
    });

    worksheet.views = [{ state: 'frozen', ySplit: headerRow.number }];

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
    const count = await MemosRepository.count(
      {
        importHash,
      },
      this.options,
    );

    return count > 0;
  }
}
