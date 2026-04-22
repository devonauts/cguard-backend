export default class SecurityGuardExportService {
  static async generatePDF(guards: any[]) {
    const PDFDocument = require('pdfkit');

    return new Promise((resolve, reject) => {
      try {
        const doc = new PDFDocument({ margin: 20, size: 'A3', layout: 'landscape', bufferPages: true });
        const chunks: Buffer[] = [];

        doc.on('data', chunk => chunks.push(chunk));
        doc.on('end', () => resolve(Buffer.concat(chunks)));

        const pageWidth = doc.page.width;
        const pageHeight = doc.page.height;
        const marginLeft = 20;
        const marginRight = 20;
        const usableWidth = pageWidth - marginLeft - marginRight;

        doc.fontSize(20).font('Helvetica-Bold').text('Lista de Guardias', marginLeft, 20, { width: usableWidth, align: 'center' });
        doc.fontSize(10).font('Helvetica').text(`Fecha: ${new Date().toLocaleDateString()}`, marginLeft, 50, { width: usableWidth, align: 'right' });

        const tableTop = 80;
        const fontSize = 9;
        doc.fontSize(fontSize).font('Helvetica-Bold');

        const colDefs = [
          { label: 'Nombre', key: 'fullName', weight: 3 },
          { label: 'Correo', key: 'email', weight: 3 },
          { label: 'Teléfono', key: 'phoneNumber', weight: 2 },
          { label: 'Estado', key: 'status', weight: 2 },
          { label: 'Cédula', key: 'governmentId', weight: 2 },
          { label: 'Fecha Contrato', key: 'hiringContractDate', weight: 2 },
          { label: 'Género', key: 'gender', weight: 1.5 },
          { label: 'Tipo Sangre', key: 'bloodType', weight: 1.5 },
          { label: 'Credenciales', key: 'guardCredentials', weight: 2.5 },
          { label: 'Fecha Nac.', key: 'birthDate', weight: 2 },
          { label: 'Lugar Nac.', key: 'birthPlace', weight: 2 },
          { label: 'Estado Civ.', key: 'maritalStatus', weight: 1.5 },
          { label: 'Educación', key: 'academicInstruction', weight: 2 },
          { label: 'Dirección', key: 'address', weight: 4 },
        ];

        const totalWeight = colDefs.reduce((s, c) => s + c.weight, 0);
        let cursorX = marginLeft;
        const cols = colDefs.map((c) => {
          const w = (usableWidth * c.weight) / totalWeight;
          const out = { label: c.label, key: c.key, x: cursorX, width: w };
          cursorX += w;
          return out;
        });

        cols.forEach(col => {
          doc.text(col.label, col.x, tableTop, { width: col.width, align: 'left', lineBreak: false });
        });

        const lineY = tableTop + 15;
        doc.moveTo(marginLeft, lineY).lineTo(pageWidth - marginRight, lineY).stroke();

        const firstRowY = lineY + 10;
        doc.font('Helvetica');
        let currentY = firstRowY;

        guards.forEach((g) => {
          if (currentY > pageHeight - 80) {
            doc.addPage();
            currentY = 40;
            doc.fontSize(fontSize).font('Helvetica-Bold');
            cols.forEach(col => {
              doc.text(col.label, col.x, currentY, { width: col.width, align: 'left', lineBreak: false });
            });
            doc.moveTo(marginLeft, currentY + 15).lineTo(pageWidth - marginRight, currentY + 15).stroke();
            currentY += 23;
            doc.font('Helvetica');
          }

          const name = (g.fullName || `${g.firstName || ''} ${g.lastName || ''}`).trim();
          const status = (g.status === 'active' || g.status === 'archived' || g.status === 'pending' || g.status === 'invited') ? g.status : (g.guard && g.guard.status) || '';
          const statusMap: any = {
            active: 'Activo',
            invited: 'Invitado',
            pending: 'Pendiente',
            archived: 'Archivado',
          };
          const email = g.email || (g.guard && (g.guard.email || g.guard.username)) || '';
          const phoneNumber = g.phoneNumber || g.phone || (g.guard && (g.guard.phoneNumber || g.guard.phone)) || '';
          const values = {
              fullName: name || '',
              email,
              phoneNumber,
              status: status ? (statusMap[status] || (String(status).charAt(0).toUpperCase() + String(status).slice(1))) : '',
              governmentId: g.governmentId || '',
              hiringContractDate: g.hiringContractDate ? new Date(g.hiringContractDate).toLocaleDateString() : '',
              gender: g.gender || (g.guard && g.guard.gender) || '',
              bloodType: g.bloodType || '',
              guardCredentials: g.guardCredentials || '',
              birthDate: g.birthDate ? new Date(g.birthDate).toLocaleDateString() : '',
              birthPlace: g.birthPlace || '',
              maritalStatus: g.maritalStatus || '',
              academicInstruction: g.academicInstruction || '',
              address: g.address || '',
            };

          doc.fontSize(8);
          cols.forEach(col => {
            const text = String(values[col.key] || '');
            doc.text(text, col.x, currentY, { width: col.width - 6, lineBreak: false, ellipsis: true });
          });

          currentY += 18;
        });

        const range = doc.bufferedPageRange();
        const totalPages = range.count;
        for (let i = 0; i < totalPages; i++) {
          doc.switchToPage(range.start + i);
          doc.fontSize(9).font('Helvetica');
          const footerText = `Página ${i + 1} de ${totalPages}`;
          const textWidth = doc.widthOfString(footerText);
          const footerX = marginLeft + (usableWidth - textWidth) / 2;
          const footerY = pageHeight - 30;
          doc.text(footerText, footerX, footerY, { lineBreak: false, continued: false });
        }

        doc.end();
      } catch (error) {
        reject(error);
      }
    });
  }

  static async generateExcel(guards: any[]) {
    const ExcelJS = require('exceljs');
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Guardias');

    const lastCol = 'N';
    worksheet.mergeCells(`A1:${lastCol}1`);
    const titleCell = worksheet.getCell('A1');
    titleCell.value = 'Lista de Guardias';
    titleCell.font = { bold: true, size: 16 };
    titleCell.alignment = { vertical: 'middle', horizontal: 'center' };

    worksheet.mergeCells(`A2:${lastCol}2`);
    worksheet.getCell('A2').value = `Fecha: ${new Date().toLocaleDateString()}`;

    const headerRow = worksheet.getRow(4);
    const headers = ['Nombre', 'Correo', 'Teléfono', 'Estado', 'Cédula', 'Fecha Contrato', 'Género', 'Tipo Sangre', 'Credenciales', 'Fecha Nac.', 'Lugar Nac.', 'Estado Civ.', 'Educación', 'Dirección'];
    const widths = [40, 35, 20, 15, 20, 18, 12, 12, 20, 15, 20, 15, 18, 50];

    headers.forEach((header, index) => {
      const cell = headerRow.getCell(index + 1);
      cell.value = header;
      cell.font = { bold: true };
      worksheet.getColumn(index + 1).width = widths[index];
    });

    let currentRow = 5;
    guards.forEach(g => {
      const row = worksheet.getRow(currentRow);
      const name = (g.fullName || `${g.firstName || ''} ${g.lastName || ''}`).trim();
      const status = (g.status === 'active' || g.status === 'archived' || g.status === 'pending' || g.status === 'invited') ? g.status : (g.guard && g.guard.status) || '';
      const statusMap: any = {
        active: 'Activo',
        invited: 'Invitado',
        pending: 'Pendiente',
        archived: 'Archivado',
      };

      const maritalMap: any = {
        soltero: 'Soltero',
        soltera: 'Soltera',
        casado: 'Casado',
        casada: 'Casada',
        divorciado: 'Divorciado',
        divorciada: 'Divorciada',
        viudo: 'Viudo',
        viuda: 'Viuda',
      };

      const genderMap: any = {
        masculino: 'Masculino',
        femenino: 'Femenino',
        other: 'Otro',
        otro: 'Otro',
      };

      const statusLabel = status ? (statusMap[status] || String(status).charAt(0).toUpperCase() + String(status).slice(1)) : '';
      const hiring = g.hiringContractDate ? new Date(g.hiringContractDate).toLocaleDateString() : '';
      const birth = g.birthDate ? new Date(g.birthDate).toLocaleDateString() : '';
      const genderLabel = g.gender ? (genderMap[String(g.gender).toLowerCase()] || g.gender) : (g.guard && g.guard.gender) || '';
      const maritalLabel = g.maritalStatus ? (maritalMap[String(g.maritalStatus).toLowerCase()] || g.maritalStatus) : '';

      const email = g.email || (g.guard && (g.guard.email || g.guard.username)) || '';
      const phone = g.phoneNumber || g.phone || (g.guard && (g.guard.phoneNumber || g.guard.phone)) || '';

      row.values = [
        name || '',
        email,
        phone,
        statusLabel,
        g.governmentId || '',
        hiring,
        genderLabel,
        g.bloodType || '',
        g.guardCredentials || '',
        birth,
        g.birthPlace || '',
        maritalLabel,
        g.academicInstruction || '',
        g.address || '',
      ];

      currentRow++;
    });

    return await workbook.xlsx.writeBuffer();
  }
}
