const PDFDocument = require('pdfkit');
const fs = require('fs');

// Generates a sample estimate PDF at tmp/estimate-sample.pdf
(async function main(){
  try {
    if(!fs.existsSync('tmp')) fs.mkdirSync('tmp');
    const outPath = 'tmp/estimate-sample.pdf';
    const doc = new PDFDocument({ size: 'A4', margin: 40 });
    const stream = fs.createWriteStream(outPath);
    doc.pipe(stream);

    const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const gap = 12;
    const leftWidth = pageWidth * 0.62;
    const rightWidth = pageWidth - leftWidth - gap;
    const startX = doc.x;
    let y = doc.y;

    // Tenant (right)
    const tenantName = 'Seguridad BAS';
    const tenantLines = [
      'Antonio Miguel de solier N29-26 y bartolome de las casas',
      'Tel: +1 863 594 2223',
      'admin@cguard.com',
    ];
    const totalsX = startX + leftWidth + gap;
    doc.font('Helvetica-Bold').fontSize(14).fillColor('#0f172a').text(tenantName, totalsX, y, { width: rightWidth, align: 'right' });
    y += 20;
    doc.font('Helvetica').fontSize(10).fillColor('#374151').text(tenantLines.join('\n'), totalsX, y, { width: rightWidth, align: 'right' });
    y += tenantLines.length * 12 + 8;

    // Left small card and totals box
    doc.rect(startX, y, leftWidth, 64).lineWidth(0.5).stroke('#e5e7eb');
    doc.font('Helvetica-Bold').fontSize(12).fillColor('#0f172a').text('Estimación', startX + 12, y + 12);

    doc.rect(totalsX, y, rightWidth, 64).lineWidth(0.5).stroke('#e5e7eb');
    doc.font('Helvetica').fontSize(10).fillColor('#6b7280').text('Total General', totalsX + 12, y + 10);
    doc.font('Helvetica-Bold').fontSize(18).fillColor('#111827').text('$288.00', totalsX + 12, y + 26);

    y += 80;

    // Header left: client name (compact)
    doc.font('Helvetica-Bold').fontSize(12).fillColor('#111827').text('', startX + 4, y + 6);

    // Title right
    const rightX = startX + leftWidth + gap;
    doc.font('Helvetica-Bold').fontSize(36).fillColor('#0f172a').text('Presupuesto', rightX, y, { width: rightWidth, align: 'right' });

    y += 40;

    // Middle boxed billing + meta
    const midBoxHeight = 120;
    const midBoxX = startX;
    const midBoxY = y;
    doc.roundedRect(midBoxX, midBoxY, pageWidth, midBoxHeight, 4).lineWidth(0.5).stroke('#e5e7eb');
    const innerPad = 12;

    // Billing
    const billingX = midBoxX + innerPad;
    const billingY = midBoxY + innerPad;
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#6b7280').text('Facturar a', billingX, billingY);
    doc.font('Helvetica-Bold').fontSize(12).fillColor('#111827').text('Luis', billingX, billingY + 16);
    doc.font('Helvetica').fontSize(10).fillColor('#374151').text('Ricardo Izurieta Del Castillo E-\npanchijos354@gmail.com\n\nelectrogamma\nytyuguygjhgjh\nlusicocha454@das.com', billingX, billingY + 36, { width: leftWidth - innerPad });

    // Meta
    const metaX = midBoxX + pageWidth - 260 - innerPad;
    const metaY = midBoxY + innerPad;
    doc.font('Helvetica').fontSize(10).fillColor('#6b7280').text('Número de Presupuesto', metaX, metaY, { width: 140 });
    doc.font('Helvetica').fontSize(10).fillColor('#111827').text('2', metaX + 140 + 6, metaY, { width: 120, align: 'right' });
    doc.font('Helvetica').fontSize(10).fillColor('#6b7280').text('Fecha del Presupuesto', metaX, metaY + 36, { width: 140 });
    doc.font('Helvetica').fontSize(10).fillColor('#111827').text('12/1/2026', metaX + 140 + 6, metaY + 36, { width: 120, align: 'right' });

    // Move below box
    doc.y = midBoxY + midBoxHeight + 6;

    // Items box
    const itemsBoxX = startX;
    const itemsBoxY = doc.y;
    const itemsBoxH = 140;
    doc.roundedRect(itemsBoxX, itemsBoxY, pageWidth, itemsBoxH, 4).lineWidth(0.5).stroke('#e5e7eb');
    const headerH = 28;
    doc.rect(itemsBoxX, itemsBoxY, pageWidth, headerH).fill('#f8fafc');

    doc.font('Helvetica-Bold').fontSize(10).fillColor('#374151').text('Artículo', itemsBoxX + 8, itemsBoxY + 6);
    doc.text('Cantidad', itemsBoxX + pageWidth*0.5, itemsBoxY + 6, { align: 'right' });
    doc.text('Tasa', itemsBoxX + pageWidth*0.62, itemsBoxY + 6, { align: 'right' });
    doc.text('Impuesto', itemsBoxX + pageWidth*0.74, itemsBoxY + 6, { align: 'right' });
    doc.text('Monto', itemsBoxX + pageWidth*0.87, itemsBoxY + 6, { align: 'right' });

    doc.font('Helvetica').fontSize(10).fillColor('#111827').text('Vigilancia nocturna', itemsBoxX + 8, itemsBoxY + headerH + 8, { width: pageWidth*0.5 - 8 });
    doc.text('1', itemsBoxX + pageWidth*0.5, itemsBoxY + headerH + 8, { width: pageWidth*0.12, align: 'right' });
    doc.text('$250.00', itemsBoxX + pageWidth*0.62, itemsBoxY + headerH + 8, { width: pageWidth*0.12, align: 'right' });
    doc.text('15.2%', itemsBoxX + pageWidth*0.74, itemsBoxY + headerH + 8, { width: pageWidth*0.13, align: 'right' });
    doc.text('$250.00', itemsBoxX + pageWidth*0.87, itemsBoxY + headerH + 8, { width: pageWidth*0.13, align: 'right' });

    // Totals
    doc.font('Helvetica').fontSize(10).fillColor('#6b7280').text('Subtotal', itemsBoxX + pageWidth - 220, itemsBoxY + itemsBoxH - 48, { width: 120, align: 'right' });
    doc.font('Helvetica').fontSize(10).fillColor('#111827').text('$250.00', itemsBoxX + pageWidth - 80, itemsBoxY + itemsBoxH - 48, { width: 60, align: 'right' });
    doc.font('Helvetica-Bold').fontSize(12).fillColor('#111827').text('Total', itemsBoxX + pageWidth - 220, itemsBoxY + itemsBoxH - 28, { width: 120, align: 'right' });
    doc.font('Helvetica-Bold').fontSize(12).text('$288.00', itemsBoxX + pageWidth - 80, itemsBoxY + itemsBoxH - 28, { width: 60, align: 'right' });

    doc.end();

    stream.on('finish', function(){
      console.log('Sample estimate PDF generated:', outPath);
    });
  } catch (err) {
    console.error('Error generating sample PDF', err);
  }
})();
