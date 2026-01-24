import { Request, Response } from 'express';
import PDFDocument from 'pdfkit';
import PermissionChecker from '../../services/user/permissionChecker';
import Permissions from '../../security/permissions';
import RequestService from '../../services/requestService';
import ApiResponseHandler from '../apiResponseHandler';
import commentsService from '../../services/comments';
import fs from 'fs';
import path from 'path';

export default async function requestExportPdf(req: Request, res: Response): Promise<void> {
  try {
    const tenantId = req.params.tenantId;
    const id = req.params.id;
    if (!tenantId || !id) {
      res.status(400).json({ message: 'Missing params' });
      return;
    }

    // build service options from the request so types match IServiceOptions
    const serviceOptions: any = {
      language: (req as any).language,
      currentUser: (req as any).currentUser,
      currentTenant: (req as any).currentTenant,
      database: (req as any).database,
    };

    new PermissionChecker(serviceOptions).validateHas(
      Permissions.values.requestRead,
    );

    // support single id (route param) or multiple ids via query `ids` (csv or repeated)
    const idsQuery = req.query.ids as string | string[] | undefined;
    let ids: string[] = [];
    if (idsQuery) {
      if (Array.isArray(idsQuery)) {
        ids = idsQuery.map((s) => String(s));
      } else {
        ids = String(idsQuery).split(',').map((s) => s.trim()).filter(Boolean);
      }
    }
    if (!ids.length && id) ids = [id];
    if (!ids.length) {
      res.status(400).json({ message: 'Missing id(s)' });
      return;
    }

    // Debug: log requested ids
    console.log('requestExportPdf — requested ids:', ids);
    const safe = (v: any) => {
      try {
        if (v === null || typeof v === 'undefined') return '-';
        if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return String(v);
        if (v instanceof Date) return v.toLocaleString();
        if (Array.isArray(v)) return v.map((x) => safe(x)).join(', ');
        if (typeof v === 'object') {
          if (v.id) return String(v.id);
          if (v.name) return String(v.name);
          if (v.fullName) return String(v.fullName);
          if (v.get && typeof v.get === 'function') {
            try {
              const plain = v.get({ plain: true });
              if (plain && plain.name) return String(plain.name);
              return JSON.stringify(plain);
            } catch (e) {
              // fallthrough
            }
          }
          try {
            return JSON.stringify(v);
          } catch (e) {
            return String(v);
          }
        }
        return String(v);
      } catch (err) {
        return '-';
      }
    };

    function safePrint(v: any) {
      try {
        if (v === null || typeof v === 'undefined') return '-';
        if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
        if (v instanceof Date) return v.toISOString();
        if (typeof v === 'object') {
          try {
            return JSON.stringify(v).slice(0, 200);
          } catch (e) {
            return String(v);
          }
        }
        return String(v);
      } catch (e) {
        return '-';
      }
    }

    // comments will be fetched per-request if needed

    // create PDF with buffered pages so we can add footers after generating content
    const doc = new PDFDocument({ size: 'A4', margin: 40, bufferPages: true });

    // set headers for download
    res.setHeader('Content-Type', 'application/pdf');
    const fileName = ids.length === 1 ? `dispatch-${ids[0]}.pdf` : `dispatch-multiple.pdf`;
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);

    // pipe to response
    doc.pipe(res);

    // Header / static helpers
    const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const startX = doc.page.margins.left;

    // Determine possible logo path (we'll draw it inside the header box later)
    let possibleLogoPath: string | null = null;
    try {
      const p = path.resolve(__dirname, '../../../../cguard-frontend-new/public/assets/logo/logo.png');
      console.log('requestExportPdf — checking logo at', p);
      if (fs.existsSync(p)) {
        possibleLogoPath = p;
        console.log('requestExportPdf — found logo at', p);
      } else {
        console.log('requestExportPdf — logo not found at', p);
      }
    } catch (e) {
      console.warn('requestExportPdf — error checking logo file', e);
    }

    // iterate requested ids and render one report per page
    for (let idx = 0; idx < ids.length; idx++) {
      const rid = ids[idx];
      // fetch the record within service context
      let requestRecord: any = null;
      try {
        requestRecord = await new RequestService(serviceOptions).findById(rid);
      } catch (e) {
        console.warn('requestExportPdf — could not load request', rid, e);
        // render a simple error page for this id
        if (idx > 0) doc.addPage();
        doc.fontSize(12).fillColor('#000').text(`Could not load request ${rid}`, startX, doc.page.margins.top);
        continue;
      }

      // lightweight debug snapshot
      try {
        console.log('requestExportPdf — snapshot:', {
          id: requestRecord?.id,
          ticketId: safePrint(requestRecord?.ticketId),
          client: safePrint(requestRecord?.client),
          site: safePrint(requestRecord?.site),
        });
      } catch (e) {
        // ignore
      }

      // new page for subsequent ids
      if (idx > 0) {
        doc.addPage();
      }

      // reset cursor for current page
      let cursorY = doc.page.margins.top;

      // Company / Tenant info centered using current tenant or requestRecord
      const headerBoxHeight = 80;
      try {
        doc.fillColor('#f7fafc');
        doc.rect(startX, cursorY, pageWidth, headerBoxHeight).fill();
      } catch (e) {
        // ignore fill errors
      }

      const logoAreaW = 80;
      const centerAreaW = pageWidth - logoAreaW - 100;
      const tenant = (req as any).currentTenant || requestRecord?.tenant || requestRecord?.companyTenant || null;
      const tenantName = tenant ? (tenant.name || tenant.tenantName || tenant.companyName) : (safe(requestRecord?.businessName) || safe(requestRecord?.company) || 'Seguridad BAS');
      doc.fillColor('#000').fontSize(13).text(tenantName, startX + logoAreaW, cursorY + 12, { width: centerAreaW, align: 'center' });

      const tenantAddress = tenant ? (tenant.address || tenant.companyAddress || tenant.location) : (safe(requestRecord?.address) || safe(requestRecord?.companyAddress) || '');
      if (tenantAddress && tenantAddress !== '-') {
        doc.fontSize(9).fillColor('#333').text(tenantAddress, startX + logoAreaW, cursorY + 30, { width: centerAreaW, align: 'center' });
      }

      const contact = tenant ? (tenant.phone || tenant.contactPhone) : (safe(requestRecord?.contactPhone) || safe(requestRecord?.phone) || '');
      if (contact && contact !== '-') {
        doc.fontSize(10).fillColor('#111').text(contact, startX + pageWidth - 90, cursorY + 18, { width: 80, align: 'right' });
      }

      // Draw left rounded white box for logo inside the header (tenant logo)
      try {
        const boxPadding = 10;
        const squareSize = headerBoxHeight - 20; // leave vertical padding
        const boxX = startX + 10;
        const boxY = cursorY + 10;
        if (typeof (doc as any).roundedRect === 'function') {
          (doc as any).roundedRect(boxX, boxY, squareSize, squareSize, 8).fill('#ffffff').stroke('#e6e6e6');
        } else {
          doc.rect(boxX, boxY, squareSize, squareSize).fill('#ffffff').stroke('#e6e6e6');
        }

        if (possibleLogoPath) {
          try {
            const imgW = squareSize - boxPadding * 2;
            const imgH = imgW;
            doc.image(possibleLogoPath, boxX + boxPadding, boxY + boxPadding, { width: imgW, height: imgH });
          } catch (e) {
            console.warn('requestExportPdf — failed to draw tenant logo inside header box', e);
          }
        }
      } catch (e) {
        console.warn('requestExportPdf — header logo block error', e);
      }

      cursorY += headerBoxHeight + 10;

      // Dispatch Report banner
      const bannerHeight = 34;
      try {
        doc.fillColor('#e6f3ff').rect(startX, cursorY, pageWidth, bannerHeight).fill();
      } catch (e) {
        // ignore
      }
      doc.fillColor('#000').fontSize(12).text('Dispatch Report', startX + 10, cursorY + 8);
      const startDate = safe(requestRecord?.startDate) !== '-' ? safe(requestRecord?.startDate) : safe(requestRecord?.createdAt);
      const endDate = safe(requestRecord?.endDate) || '';
      const dateBlock = endDate && endDate !== '-' ? `Start Date : ${startDate}\nEnd Date : ${endDate}` : `Date : ${startDate}`;
      doc.fontSize(9).fillColor('#333').text(dateBlock, startX + pageWidth - 220, cursorY + 6, { width: 210, align: 'right' });

      cursorY += bannerHeight + 12;

      // Section header + status badge
      doc.fontSize(14).fillColor('#111').text('1. Accident', startX, cursorY);
      const status = (requestRecord && (requestRecord.status || requestRecord.state || '')) || '';
      const sStatus = String(status).toLowerCase();
      const isClosed = sStatus.includes('close') || sStatus.includes('cerrad') || sStatus === 'closed' || sStatus === 'cerrado';
      const isOpen = sStatus.includes('open') || sStatus.includes('abiert') || sStatus === 'open' || sStatus === 'abierto';

      if (isClosed) {
        const badgeW = 60;
        try {
          // green badge for closed
          doc.fillColor('#d1fae5').rect(startX + pageWidth - badgeW - 10, cursorY - 2, badgeW, 18).fill();
          doc.fillColor('#065f46').fontSize(9).text('Closed', startX + pageWidth - badgeW - 10, cursorY + 1, { width: badgeW, align: 'center' });
        } catch (e) {
          // ignore
        }
      } else if (isOpen) {
        const badgeW = 60;
        try {
          // red badge for open
          doc.fillColor('#fee2e2').rect(startX + pageWidth - badgeW - 10, cursorY - 2, badgeW, 18).fill();
          doc.fillColor('#991b1b').fontSize(9).text('Open', startX + pageWidth - badgeW - 10, cursorY + 1, { width: badgeW, align: 'center' });
        } catch (e) {
          // ignore
        }
      }

      cursorY += 26;

      // Table rows
      const tableX = startX;
      const tableWidth = pageWidth;
      const colMid = tableX + Math.floor(tableWidth * 0.5);
      const rowHeight = 22;

      const drawCellRow = (lLabel: string, lValue: any, rLabel?: string, rValue?: any) => {
        doc.save();
        doc.lineWidth(0.5).strokeColor('#e2e8f0');
        doc.rect(tableX, cursorY, tableWidth, rowHeight).stroke();
        doc.fontSize(9).fillColor('#666').text(lLabel, tableX + 8, cursorY + 6);
        doc.fontSize(9).fillColor('#000').text(lValue || '-', tableX + 110, cursorY + 6);
        if (rLabel) {
          doc.fontSize(9).fillColor('#666').text(rLabel, colMid + 8, cursorY + 6);
          doc.fontSize(9).fillColor('#000').text(rValue || '-', colMid + 110, cursorY + 6);
        }
        doc.restore();
        cursorY += rowHeight;
      };

      const addedDate = safe(requestRecord?.createdAt);
      drawCellRow('Added Date', addedDate, 'Client', safe(requestRecord?.client));
      drawCellRow('Post Site', safe(requestRecord?.site), 'Caller Type', safe(requestRecord?.callerType));
      drawCellRow('Caller Name', safe(requestRecord?.callerName), 'Incident Location', safe(requestRecord?.location));
      drawCellRow('Priority', safe(requestRecord?.priority), 'Incident Type', safe(requestRecord?.incidentType));

      // Two-box layout
      cursorY += 6;
      const gap = 12;
      const boxW = Math.floor((tableWidth - gap) / 2);
      const leftX = tableX;
      const rightX = tableX + boxW + gap;

      const leftText = safe(requestRecord?.content) || safe(requestRecord?.details) || '-';
      const rightText = safe(requestRecord?.internalNotes) || safe(requestRecord?.notes) || '-';

      let leftTextHeight = 0;
      let rightTextHeight = 0;
      try { leftTextHeight = doc.heightOfString(leftText, { width: boxW - 12 }); } catch (e) { leftTextHeight = 40; }
      try { rightTextHeight = doc.heightOfString(rightText, { width: boxW - 12 }); } catch (e) { rightTextHeight = 40; }

      const contentHeight = Math.max(leftTextHeight, rightTextHeight);
      const headerPadding = 30;
      const boxHeight = Math.max(80, contentHeight + headerPadding);

      try { doc.lineWidth(0.5).strokeColor('#e2e8f0').rect(leftX, cursorY, boxW, boxHeight).stroke(); } catch (e) { }
      doc.fontSize(11).fillColor('#000').text('Incident Details', leftX + 6, cursorY + 6);
      doc.fontSize(9).fillColor('#000').text(leftText, leftX + 6, cursorY + 26, { width: boxW - 12 });

      try { doc.lineWidth(0.5).strokeColor('#e2e8f0').rect(rightX, cursorY, boxW, boxHeight).stroke(); } catch (e) { }
      doc.fontSize(11).fillColor('#000').text('Notes', rightX + 6, cursorY + 6);
      doc.fontSize(9).fillColor('#000').text(rightText, rightX + 6, cursorY + 26, { width: boxW - 12 });

      cursorY += boxHeight + 18;

    }

    // Add footer (page numbers and branding) to all buffered pages, then finalize
    try {
      const range = doc.bufferedPageRange(); // { start: 0, count: n }
      for (let i = range.start; i < range.start + range.count; i++) {
        doc.switchToPage(i);
        const bottomY = doc.page.height - 30;
        const pageNumText = `Page ${i - range.start + 1} of ${range.count}`;
        const poweredText = 'Powered by Cguard';
        doc.fontSize(8).fillColor('#666');
        // compute widths to place explicitly
        const pageNumWidth = (doc as any).widthOfString ? (doc as any).widthOfString(pageNumText) : 60;
        const poweredWidth = (doc as any).widthOfString ? (doc as any).widthOfString(poweredText) : 100;
        const leftX = doc.page.margins.left;
        const rightX = doc.page.width - doc.page.margins.right - poweredWidth;
        // draw page number at leftX (no wrapping)
        doc.text(pageNumText, leftX, bottomY, { lineBreak: false });
        // draw powered text at rightX (no wrapping)
        doc.text(poweredText, rightX, bottomY, { lineBreak: false });
      }
    } catch (e) {
      console.warn('requestExportPdf — footer generation failed', e);
    }

    doc.end();
    return;
  } catch (err: any) {
    console.error('requestExportPdf error', err);
    return ApiResponseHandler.error(req, res, err);
  }
}
