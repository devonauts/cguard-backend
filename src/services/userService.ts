import UserRepository from '../database/repositories/userRepository';
import PDFDocument from 'pdfkit';
import ExcelJS from 'exceljs';

export default class UserService {
  options: any;

  constructor(options) {
    this.options = options;
  }

  async exportToFile(format, filter = {}) {
    const { rows } = await UserRepository.findAndCountAll(
      { filter, limit: 0, offset: 0, orderBy: 'email_ASC' },
      this.options,
    );

    // Exclude security guards from exports
    const filteredRows = (rows || []).filter(
      (r) => !((r.roles || []).includes('securityGuard')),
    );

    if (format === 'pdf') {
      return this._generatePDF(filteredRows);
    }

    if (format === 'excel') {
      return this._generateExcel(filteredRows);
    }

    return null;
  }

  _generatePDF(rows) {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 40 });
      const chunks: any[] = [];
      doc.on('data', (chunk) => chunks.push(chunk));
      const endPromise = new Promise((resolve, reject) => {
        doc.on('end', () => {
          resolve(Buffer.concat(chunks));
        });
        doc.on('error', reject);
      });

      const pageWidth = doc.page.width;
      const pageHeight = doc.page.height;
      const marginLeft = 40;
      const marginTop = 40;
      const usableWidth = pageWidth - marginLeft - 40;

      // Column positions: Name | Email | Phone | Roles
      const nameX = marginLeft;
      const emailX = marginLeft + Math.floor(usableWidth * 0.35);
      const phoneX = marginLeft + Math.floor(usableWidth * 0.65);
      const rolesX = marginLeft + Math.floor(usableWidth * 0.8);
      const lineHeight = 16;

      // Title and export date
      doc.fontSize(16).font('Helvetica-Bold').text('Users Report', { align: 'center' });
      doc.moveDown(0.5);
      doc.fontSize(10).font('Helvetica').text(`Exported: ${new Date().toLocaleString()}`, { align: 'center' });
      let y = doc.y + 10;

      // Header
      doc.fontSize(10).font('Helvetica-Bold');
      doc.text('Name', nameX, y);
      doc.text('Email', emailX, y);
      doc.text('Phone', phoneX, y);
      doc.text('Roles', rolesX, y);
      y += lineHeight;

      doc.moveTo(marginLeft, y - 6).lineTo(pageWidth - 40, y - 6).stroke();

      doc.font('Helvetica').fontSize(10);

      (rows || []).forEach((r) => {
        if (y > pageHeight - 60) {
          doc.addPage();
          y = marginTop;
          doc.fontSize(10).font('Helvetica-Bold');
          doc.text('Name', nameX, y);
          doc.text('Email', emailX, y);
          doc.text('Roles', rolesX, y);
          y += lineHeight;
          doc.moveTo(marginLeft, y - 6).lineTo(pageWidth - 40, y - 6).stroke();
          doc.font('Helvetica').fontSize(10);
        }

        const name = (r.fullName || r.name || '').toString();
        const email = (r.email || '').toString();
        const phone = (r.phoneNumber || r.phone || '').toString();
        const roles = (r.roles || []).join(', ');

        doc.text(name, nameX, y, { width: emailX - nameX - 10 });
        doc.text(email, emailX, y, { width: phoneX - emailX - 10 });
        doc.text(phone, phoneX, y, { width: rolesX - phoneX - 10 });
        doc.text(roles, rolesX, y, { width: pageWidth - rolesX - 40 });

        y += lineHeight;
      });

      doc.end();

      return endPromise.then((buffer) => ({ buffer: buffer as Buffer, mimeType: 'application/pdf' }));
    } catch (e) {
      throw e;
    }
  }

  async _generateExcel(rows) {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Users');
    // Title row (merged)
    sheet.mergeCells('A1:D1');
    const titleCell = sheet.getCell('A1');
    titleCell.value = 'Users Report';
    titleCell.font = { size: 16, bold: true };
    titleCell.alignment = { horizontal: 'center' };

    // Export date row
    sheet.mergeCells('A2:D2');
    const dateCell = sheet.getCell('A2');
    dateCell.value = `Exported: ${new Date().toLocaleString()}`;
    dateCell.font = { size: 10 };
    dateCell.alignment = { horizontal: 'center' };

    // Blank row
    sheet.addRow([]);

    // Header row
    sheet.addRow(['Name', 'Email', 'Phone', 'Roles']);
    const headerRow = sheet.getRow(4);
    headerRow.font = { bold: true };
    headerRow.alignment = { horizontal: 'left' };

    // Column widths
    sheet.columns = [
      { key: 'name', width: 30 },
      { key: 'email', width: 35 },
      { key: 'phone', width: 16 },
      { key: 'roles', width: 30 },
    ];

    // Freeze header (rows above header included)
    sheet.views = [{ state: 'frozen', ySplit: 4 }];

    // Data rows start after header
    (rows || []).forEach((r) => {
      sheet.addRow([
        r.fullName || r.name || '',
        r.email || '',
        r.phoneNumber || r.phone || '',
        (r.roles || []).join(', '),
      ]);
    });

    const buffer = await workbook.xlsx.writeBuffer();
    return { buffer, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
  }
}
