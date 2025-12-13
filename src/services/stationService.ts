import Error400 from '../errors/Error400';
import SequelizeRepository from '../database/repositories/sequelizeRepository';
import { IServiceOptions } from './IServiceOptions';
import StationRepository from '../database/repositories/stationRepository';
import ClientAccountRepository from '../database/repositories/clientAccountRepository';
import TaskRepository from '../database/repositories/taskRepository';
import ReportRepository from '../database/repositories/reportRepository';
import IncidentRepository from '../database/repositories/incidentRepository';
import PatrolCheckpointRepository from '../database/repositories/patrolCheckpointRepository';
import PatrolRepository from '../database/repositories/patrolRepository';
import ShiftRepository from '../database/repositories/shiftRepository';
import UserRepository from '../database/repositories/userRepository';

export default class StationService {
  options: IServiceOptions;

  constructor(options) {
    this.options = options;
  }

  async create(data) {
    const transaction = await SequelizeRepository.createTransaction(
      this.options.database,
    );

    try {
      data.stationOrigin = await ClientAccountRepository.filterIdInTenant(data.stationOrigin, { ...this.options, transaction });
      data.assignedGuards = await UserRepository.filterIdsInTenant(data.assignedGuards, { ...this.options, transaction });
      data.tasks = await TaskRepository.filterIdsInTenant(data.tasks, { ...this.options, transaction });
      data.reports = await ReportRepository.filterIdsInTenant(data.reports, { ...this.options, transaction });
      data.incidents = await IncidentRepository.filterIdsInTenant(data.incidents, { ...this.options, transaction });
      data.checkpoints = await PatrolCheckpointRepository.filterIdsInTenant(data.checkpoints, { ...this.options, transaction });
      data.patrol = await PatrolRepository.filterIdsInTenant(data.patrol, { ...this.options, transaction });
      data.shift = await ShiftRepository.filterIdsInTenant(data.shift, { ...this.options, transaction });

      const record = await StationRepository.create(data, {
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
        'station',
      );

      throw error;
    }
  }

  async update(id, data) {
    const transaction = await SequelizeRepository.createTransaction(
      this.options.database,
    );

    try {
      data.stationOrigin = await ClientAccountRepository.filterIdInTenant(data.stationOrigin, { ...this.options, transaction });
      data.assignedGuards = await UserRepository.filterIdsInTenant(data.assignedGuards, { ...this.options, transaction });
      data.tasks = await TaskRepository.filterIdsInTenant(data.tasks, { ...this.options, transaction });
      data.reports = await ReportRepository.filterIdsInTenant(data.reports, { ...this.options, transaction });
      data.incidents = await IncidentRepository.filterIdsInTenant(data.incidents, { ...this.options, transaction });
      data.checkpoints = await PatrolCheckpointRepository.filterIdsInTenant(data.checkpoints, { ...this.options, transaction });
      data.patrol = await PatrolRepository.filterIdsInTenant(data.patrol, { ...this.options, transaction });
      data.shift = await ShiftRepository.filterIdsInTenant(data.shift, { ...this.options, transaction });

      const record = await StationRepository.update(
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
        'station',
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
        await StationRepository.destroy(id, {
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
    return StationRepository.findById(id, this.options);
  }

  async findAllAutocomplete(search, limit) {
    return StationRepository.findAllAutocomplete(
      search,
      limit,
      this.options,
    );
  }

  async findAndCountAll(args) {
    return StationRepository.findAndCountAll(
      args,
      this.options,
    );
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
    const count = await StationRepository.count(
      {
        importHash,
      },
      this.options,
    );

    return count > 0;
  }

  async exportToFile(format, filter = {}) {
    const { rows } = await StationRepository.findAndCountAll(
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

  async _generatePDF(stations) {
    const PDFDocument = require('pdfkit');
    
    return new Promise((resolve, reject) => {
      try {
        const doc = new PDFDocument({ 
          margin: 30,
          size: 'A4',
          bufferPages: true,
        });
        const chunks: Buffer[] = [];

        doc.on('data', chunk => chunks.push(chunk));
        doc.on('end', () => resolve(Buffer.concat(chunks)));

        // Dimensiones de la página
        const pageWidth = doc.page.width;
        const pageHeight = doc.page.height;
        const marginLeft = 30;
        const marginRight = 30;
        const usableWidth = pageWidth - marginLeft - marginRight;

        // Header
        doc.fontSize(24).font('Helvetica-Bold').text('Lista de Sitios de Publicación', marginLeft, 30, { 
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
        const colWidth = usableWidth / 4;
        const cols = [
          { label: 'Sitio de Publicación', x: marginLeft, width: colWidth * 2 },
          { label: 'Correo Electrónico', x: marginLeft + colWidth * 2, width: colWidth },
          { label: 'Número de Teléfono', x: marginLeft + colWidth * 3, width: colWidth },
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
        
        stations.forEach((station, index) => {
          // Si no cabe en la página, agregar nueva página
          if (currentY > pageHeight - 80) {
            doc.addPage();
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
            { text: station.name || '', x: marginLeft, width: colWidth * 2 },
            { text: station.email || '', x: marginLeft + colWidth * 2, width: colWidth },
            { text: station.phoneNumber || '', x: marginLeft + colWidth * 3, width: colWidth },
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

  async _generateExcel(stations) {
    const ExcelJS = require('exceljs');
    
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Sitios');

    // Agregar título
    worksheet.mergeCells('A1:C1');
    const titleCell = worksheet.getCell('A1');
    titleCell.value = 'Lista de Sitios de Publicación';
    titleCell.font = { bold: true, size: 16, color: { argb: 'FF000000' } };
    titleCell.alignment = { vertical: 'middle', horizontal: 'center' };
    titleCell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFE0E0E0' }
    };

    // Agregar fecha
    worksheet.mergeCells('A2:C2');
    const dateCell = worksheet.getCell('A2');
    dateCell.value = `Fecha: ${new Date().toLocaleDateString()}`;
    dateCell.font = { size: 11, color: { argb: 'FF000000' } };
    dateCell.alignment = { vertical: 'middle', horizontal: 'right' };

    // Agregar fila vacía
    worksheet.getRow(3).height = 5;

    // Add headers en la fila 4
    const headerRow = worksheet.getRow(4);
    const headers = ['Sitio de Publicación', 'Correo Electrónico', 'Número de Teléfono'];
    const widths = [40, 35, 25];
    
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
    stations.forEach(station => {
      const row = worksheet.getRow(currentRow);
      row.values = [
        station.name || '',
        station.email || '',
        station.phoneNumber || '',
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
