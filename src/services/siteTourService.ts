import SequelizeRepository from '../database/repositories/sequelizeRepository';
import { IServiceOptions } from './IServiceOptions';

export default class SiteTourService {
  options: IServiceOptions;

  constructor(options) {
    this.options = options;
  }

  async findById(id: string) {
    const transaction = SequelizeRepository.getTransaction(this.options);
    const record = await this.options.database.siteTour.findOne({ where: { id }, include: ['tags'], transaction });
    if (!record) {
      throw new Error('Not found');
    }
    return record;
  }

  async assignGuard(
    tourId: string,
    guardId: string,
    payload: {
      startAt?: string | Date | null;
      endAt?: string | Date | null;
      status?: string;
      stationId?: string | null;
      postSiteId?: string | null;
    } = {},
  ) {
    const transaction = await SequelizeRepository.createTransaction(this.options.database);
    try {
      const assignment = await this.options.database.tourAssignment.create({
        siteTourId: tourId,
        securityGuardId: guardId,
        startAt: payload.startAt ?? null,
        endAt: payload.endAt ?? null,
        status: payload.status ?? 'assigned',
        stationId: payload.stationId ?? null,
        postSiteId: payload.postSiteId ?? null,
        tenantId: this.options.currentTenant ? this.options.currentTenant.id : null,
        createdById: this.options.currentUser ? this.options.currentUser.id : null,
        updatedById: this.options.currentUser ? this.options.currentUser.id : null,
      }, { transaction });

      await SequelizeRepository.commitTransaction(transaction);
      return assignment;
    } catch (err) {
      await SequelizeRepository.rollbackTransaction(transaction);
      throw err;
    }
  }

  /**
   * Record a tag scan coming from a guard device.
   * Attempts to find the SiteTourTag by `tagIdentifier` and the active assignment for the guard.
   */
  async recordTagScan({ tagIdentifier, securityGuardId, latitude, longitude, scannedData, stationId }) {
    const transaction = await SequelizeRepository.createTransaction(this.options.database);
    try {
      const tag = await this.options.database.siteTourTag.findOne({ where: { tagIdentifier }, transaction });
      if (!tag) {
        const err: any = new Error('Tag not found');
        err.code = 404;
        throw err;
      }

      // Find an active assignment for this tour (no longer scoped to a specific guard)
      const assignment = await this.options.database.tourAssignment.findOne({
        where: {
          siteTourId: tag.siteTourId,
          status: 'assigned',
        },
        transaction,
      });

      // Ensure assignment has tenantId when request provides currentTenant
      if (assignment && this.options.currentTenant && this.options.currentTenant.id && !assignment.tenantId) {
        // update assignment tenantId so table reflects tenant ownership
        await assignment.update({ tenantId: this.options.currentTenant.id }, { transaction });
      }

      // If we have an assignment, ensure idempotency: don't double-count same tag for the same assignment
      let scan = null;
      if (assignment) {
        const existing = await this.options.database.tagScan.findOne({
          where: {
            tourAssignmentId: assignment.id,
            siteTourTagId: tag.id,
          },
          transaction,
        });
        if (existing) {
          // already scanned this tag for this assignment — return without incrementing
          await SequelizeRepository.commitTransaction(transaction);
          return { tag, assignment, scan: existing };
        }
      }

      // Create tagScan row
      scan = await this.options.database.tagScan.create({
        siteTourTagId: tag.id,
        tourAssignmentId: assignment ? assignment.id : null,
        securityGuardId,
        stationId: stationId || null,
        scannedAt: new Date(),
        scannedData: { latitude, longitude, extra: scannedData },
      }, { transaction });

      // If assignment exists, increment scansCompleted and mark completed when reaching total tags
      if (assignment) {
        // increment atomically
        await assignment.increment('scansCompleted', { by: 1, transaction });

        // get current scansCompleted value
        await assignment.reload({ transaction });

        // count total tags for the tour
        const totalTags = await this.options.database.siteTourTag.count({ where: { siteTourId: tag.siteTourId }, transaction });

        if ((assignment as any).scansCompleted >= totalTags) {
          await assignment.update({ status: 'completed', completedAt: new Date() }, { transaction });
        }
      }

      await SequelizeRepository.commitTransaction(transaction);
      return { tag, assignment, scan };
    } catch (err) {
      await SequelizeRepository.rollbackTransaction(transaction);
      throw err;
    }
  }

  async listAssignments(tourId: string) {
    const transaction = SequelizeRepository.getTransaction(this.options);
    const where: any = { siteTourId: tourId };
    if (this.options.currentTenant && this.options.currentTenant.id) {
      where.tenantId = this.options.currentTenant.id;
    }
    const rows = await this.options.database.tourAssignment.findAll({ where, transaction });
    return rows;
  }

  async getAssignment(assignmentId: string) {
    const transaction = SequelizeRepository.getTransaction(this.options);
    const where: any = { id: assignmentId };
    if (this.options.currentTenant && this.options.currentTenant.id) where.tenantId = this.options.currentTenant.id;
    const record = await this.options.database.tourAssignment.findOne({ where, transaction });
    if (!record) {
      const err: any = new Error('Not found'); err.code = 404; throw err;
    }
    return record;
  }

  async updateAssignment(assignmentId: string, data: any) {
    const transaction = await SequelizeRepository.createTransaction(this.options.database);
    try {
      const where: any = { id: assignmentId };
      if (this.options.currentTenant && this.options.currentTenant.id) where.tenantId = this.options.currentTenant.id;
      const record = await this.options.database.tourAssignment.findOne({ where, transaction });
      if (!record) {
        const err: any = new Error('Not found'); err.code = 404; throw err;
      }

      const updateData: any = {};
      // allow updates to these fields
      const allowed = ['startAt', 'endAt', 'status', 'securityGuardId', 'postSiteId', 'stationId', 'importHash'];
      allowed.forEach((k) => {
        if (Object.prototype.hasOwnProperty.call(data, k)) updateData[k] = data[k];
      });
      updateData.updatedById = this.options.currentUser ? this.options.currentUser.id : null;
      await record.update(updateData, { transaction });
      await SequelizeRepository.commitTransaction(transaction);
      return record;
    } catch (err) {
      await SequelizeRepository.rollbackTransaction(transaction);
      throw err;
    }
  }

  async deleteAssignment(assignmentId: string) {
    const transaction = await SequelizeRepository.createTransaction(this.options.database);
    try {
      const where: any = { id: assignmentId };
      if (this.options.currentTenant && this.options.currentTenant.id) where.tenantId = this.options.currentTenant.id;
      const record = await this.options.database.tourAssignment.findOne({ where, transaction });
      if (!record) {
        const err: any = new Error('Not found'); err.code = 404; throw err;
      }
      await record.destroy({ transaction });
      await SequelizeRepository.commitTransaction(transaction);
      return {};
    } catch (err) {
      await SequelizeRepository.rollbackTransaction(transaction);
      throw err;
    }
  }

  async listTagScans(filter: any = {}) {
    const transaction = SequelizeRepository.getTransaction(this.options);
    const where: any = {};

    if (this.options.currentTenant && this.options.currentTenant.id) {
      where['$tag.siteTour.tenantId$'] = this.options.currentTenant.id;
    }

    if (filter.tourId) where['$tag.siteTourId$'] = filter.tourId;
    if (filter.postSiteId) where['$tag.siteTour.postSiteId$'] = filter.postSiteId;
    if (filter.stationId) where.stationId = filter.stationId;
    if (filter.assignmentId) where.tourAssignmentId = filter.assignmentId;

    const limit = filter.limit ? parseInt(filter.limit, 10) : 0;
    const offset = filter.offset ? parseInt(filter.offset, 10) : 0;

    const rows = await this.options.database.tagScan.findAll({
      where,
      include: [
        { model: this.options.database.siteTourTag, as: 'tag', include: [{ model: this.options.database.siteTour, as: 'siteTour' }] },
        { model: this.options.database.tourAssignment, as: 'assignment' },
        { model: this.options.database.securityGuard, as: 'guard' },
        { model: this.options.database.station, as: 'station' },
      ],
      order: [['scannedAt', 'DESC']],
      limit: limit || undefined,
      offset: offset || undefined,
      transaction,
    });

    const plain = (rows || []).map((r: any) => (typeof r.get === 'function' ? r.get({ plain: true }) : r));
    return plain;
  }

  async exportScansToFile(format: string, filter: any = {}) {
    const rows = await this.listTagScans(filter);

    // transform rows to export-friendly shape
    const transformed = (rows || []).map((r: any) => {
      return {
        scannedAt: r.scannedAt,
        tagIdentifier: r.tag ? (r.tag.tagIdentifier || r.tag.id) : null,
        tagName: r.tag ? (r.tag.name || null) : null,
        tourId: r.tag && r.tag.siteTourId ? r.tag.siteTourId : null,
        tourName: r.tag && r.tag.siteTour ? r.tag.siteTour.name : null,
        stationId: r.stationId || (r.station && r.station.id) || null,
        stationName: r.station ? (r.station.stationName || r.station.name) : null,
        guardId: r.securityGuardId || (r.guard && r.guard.id) || null,
        guardName: r.guard ? (r.guard.firstName || r.guard.name || r.guard.username || null) : null,
        scannedData: r.scannedData || null,
      };
    });

    if (format === 'pdf') return this._generateScansPDF(transformed);
    if (format === 'excel') return this._generateScansExcel(transformed);
    throw new Error('Formato no soportado');
  }

  _generateScansPDF(rows: any[]) {
    const PDFDocument = require('pdfkit');
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 40 });
      const chunks: any[] = [];
      doc.on('data', (chunk) => chunks.push(chunk));
      const endPromise = new Promise((resolve, reject) => {
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);
      });

      doc.fontSize(16).font('Helvetica-Bold').text('Tag Scans Report', { align: 'center' });
      doc.moveDown(0.5);
      doc.fontSize(10).font('Helvetica').text(`Exported: ${new Date().toLocaleString()}`, { align: 'center' });
      let y = doc.y + 10;

      const pageWidth = doc.page.width;
      const marginLeft = 40;
      const usableWidth = pageWidth - marginLeft - 40;
      const col1 = marginLeft; // scannedAt
      const col2 = marginLeft + Math.floor(usableWidth * 0.22); // tag
      const col3 = marginLeft + Math.floor(usableWidth * 0.42); // tour
      const col4 = marginLeft + Math.floor(usableWidth * 0.62); // station
      const col5 = marginLeft + Math.floor(usableWidth * 0.82); // guard
      const lineHeight = 14;

      doc.fontSize(9).font('Helvetica-Bold');
      doc.text('Scanned At', col1, y);
      doc.text('Tag', col2, y);
      doc.text('Tour', col3, y);
      doc.text('Station', col4, y);
      doc.text('Guard', col5, y);
      y += lineHeight;
      doc.moveTo(marginLeft, y - 6).lineTo(pageWidth - 40, y - 6).stroke();
      doc.font('Helvetica').fontSize(9);

      (rows || []).forEach((r) => {
        if (y > doc.page.height - 60) {
          doc.addPage();
          y = 40;
        }
        const scannedAt = r.scannedAt ? new Date(r.scannedAt).toLocaleString() : '';
        doc.text(scannedAt, col1, y, { width: col2 - col1 - 6 });
        doc.text(r.tagIdentifier || r.tagName || '', col2, y, { width: col3 - col2 - 6 });
        doc.text(r.tourName || '', col3, y, { width: col4 - col3 - 6 });
        doc.text(r.stationName || '', col4, y, { width: col5 - col4 - 6 });
        doc.text(r.guardName || '', col5, y, { width: pageWidth - col5 - 40 });
        y += lineHeight;
      });

      doc.end();
      return endPromise.then((buffer) => ({ buffer: buffer as Buffer, mimeType: 'application/pdf' }));
    } catch (e) {
      throw e;
    }
  }

  async _generateScansExcel(rows: any[]) {
    const ExcelJS = require('exceljs');
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('TagScans');
    sheet.mergeCells('A1:E1');
    const titleCell = sheet.getCell('A1');
    titleCell.value = 'Tag Scans Report';
    titleCell.font = { size: 16, bold: true };
    titleCell.alignment = { horizontal: 'center' };
    sheet.mergeCells('A2:E2');
    const dateCell = sheet.getCell('A2');
    dateCell.value = `Exported: ${new Date().toLocaleString()}`;
    sheet.addRow([]);
    sheet.addRow(['Scanned At', 'Tag', 'Tour', 'Station', 'Guard']);
    const headerRow = sheet.getRow(4);
    headerRow.font = { bold: true };
    sheet.columns = [
      { key: 'scannedAt', width: 24 },
      { key: 'tag', width: 24 },
      { key: 'tour', width: 30 },
      { key: 'station', width: 24 },
      { key: 'guard', width: 24 },
    ];

    (rows || []).forEach((r) => {
      sheet.addRow([
        r.scannedAt ? new Date(r.scannedAt).toLocaleString() : '',
        r.tagIdentifier || r.tagName || '',
        r.tourName || '',
        r.stationName || '',
        r.guardName || '',
      ]);
    });

    const buffer = await workbook.xlsx.writeBuffer();
    return { buffer, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
  }
}
