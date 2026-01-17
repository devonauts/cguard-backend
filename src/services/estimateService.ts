import Error400 from '../errors/Error400';
import SequelizeRepository from '../database/repositories/sequelizeRepository';
import Sequelize from 'sequelize';
import { getConfig } from '../config';
import { IServiceOptions } from './IServiceOptions';
import EstimateRepository from '../database/repositories/estimateRepository';
import ClientAccountRepository from '../database/repositories/clientAccountRepository';
import BusinessInfoRepository from '../database/repositories/businessInfoRepository';
import InvoiceService from './invoiceService';
import NotificationService from './notificationService';

const PDFDocument = require('pdfkit');

export default class EstimateService {
  options: IServiceOptions;

  constructor(options) {
    this.options = options;
  }

  async create(data) {
    const transaction = await SequelizeRepository.createTransaction(this.options.database);

    try {
      data.clientId = await ClientAccountRepository.filterIdInTenant(data.clientId, { ...this.options, transaction });
      data.postSiteId = await BusinessInfoRepository.filterIdInTenant(data.postSiteId, { ...this.options, transaction });

      // Auto-generate estimateNumber if not provided
      if (!data.estimateNumber) {
        const tenant = SequelizeRepository.getCurrentTenant(this.options);

        // Determine formatting option: numeric (default) or year-prefixed 'YYYY-0001'
        const format = (getConfig() && getConfig().ESTIMATE_NUMBER_FORMAT) || 'numeric';

        try {
          // Fetch existing estimates for this tenant and compute max value
          const allResult = await EstimateRepository.findAndCountAll({ filter: null, limit: 0 }, this.options);
          const rows = (allResult && Array.isArray(allResult.rows)) ? allResult.rows : [];

          if (format === 'year') {
            const year = (new Date()).getFullYear();
            // find max suffix for current year
            let maxSuffix = 0;
            for (const r of rows) {
              const raw = r && (r.estimateNumber || r.number || '');
              if (!raw) continue;
              const m = String(raw).match(/^(\d{4})-(\d+)$/);
              if (m && Number(m[1]) === year) {
                const suf = parseInt(m[2] || '0', 10) || 0;
                if (suf > maxSuffix) maxSuffix = suf;
              }
            }

            let nextNumber = maxSuffix + 1;
            let candidate = `${year}-${String(nextNumber).padStart(4, '0')}`;

            // Ensure uniqueness (safety loop)
            let attempts = 0;
            while ((await EstimateRepository.count({ estimateNumber: candidate }, this.options)) > 0) {
              attempts += 1;
              if (attempts > 1000) break;
              nextNumber += 1;
              candidate = `${year}-${String(nextNumber).padStart(4, '0')}`;
            }
            data.estimateNumber = candidate;
          } else {
            // numeric: compute max numeric portion across all estimateNumber values
            let maxVal = 0;
            for (const r of rows) {
              const raw = r && (r.estimateNumber || r.number || '');
              if (!raw) continue;
              const digits = String(raw).replace(/[^0-9]/g, '');
              const parsed = parseInt(digits || '0', 10) || 0;
              if (parsed > maxVal) maxVal = parsed;
            }
            let nextNumber = maxVal + 1;
            let candidate = String(nextNumber);

            let attempts = 0;
            while ((await EstimateRepository.count({ estimateNumber: candidate }, this.options)) > 0) {
              attempts += 1;
              if (attempts > 1000) break;
              nextNumber += 1;
              candidate = String(nextNumber);
            }
            data.estimateNumber = candidate;
          }
        } catch (err) {
          // Fallback in case of unexpected DB errors: default to simple numbering
          const year = (new Date()).getFullYear();
          data.estimateNumber = (getConfig() && getConfig().ESTIMATE_NUMBER_FORMAT) === 'year' ? `${year}-0001` : '1';
        }
      }

      const record = await EstimateRepository.create(data, { ...this.options, transaction });

      await SequelizeRepository.commitTransaction(transaction);

      return record;
    } catch (error) {
      await SequelizeRepository.rollbackTransaction(transaction);

      SequelizeRepository.handleUniqueFieldError(error, this.options.language, 'estimate');

      throw error;
    }
  }

  async update(id, data) {
    const transaction = await SequelizeRepository.createTransaction(this.options.database);

    try {
      data.clientId = await ClientAccountRepository.filterIdInTenant(data.clientId, { ...this.options, transaction });
      data.postSiteId = await BusinessInfoRepository.filterIdInTenant(data.postSiteId, { ...this.options, transaction });

      const record = await EstimateRepository.update(id, data, { ...this.options, transaction });

      await SequelizeRepository.commitTransaction(transaction);

      return record;
    } catch (error) {
      await SequelizeRepository.rollbackTransaction(transaction);
      SequelizeRepository.handleUniqueFieldError(error, this.options.language, 'estimate');
      throw error;
    }
  }

  async destroyAll(ids) {
    const transaction = await SequelizeRepository.createTransaction(this.options.database);

    try {
      for (const id of ids) {
        await EstimateRepository.destroy(id, { ...this.options, transaction });
      }

      await SequelizeRepository.commitTransaction(transaction);
    } catch (error) {
      await SequelizeRepository.rollbackTransaction(transaction);
      throw error;
    }
  }

  async findById(id) {
    return EstimateRepository.findById(id, this.options);
  }

  async findAllAutocomplete(search, limit) {
    return EstimateRepository.findAllAutocomplete(search, limit, this.options);
  }

  async findAndCountAll(args) {
    return EstimateRepository.findAndCountAll(args, this.options);
  }

  async import(data, importHash) {
    if (!importHash) {
      throw new Error400(this.options.language, 'importer.errors.importHashRequired');
    }

    if (await this._isImportHashExistent(importHash)) {
      throw new Error400(this.options.language, 'importer.errors.importHashExistent');
    }

    const dataToCreate = { ...data, importHash };

    return this.create(dataToCreate);
  }

  async _isImportHashExistent(importHash) {
    const count = await EstimateRepository.count({ importHash }, this.options);
    return count > 0;
  }

  async send(id) {
    // Minimal send implementation: verify exists and optionally create a notification.
    const record = await EstimateRepository.findById(id, this.options);

    try {
      const notificationService = new NotificationService(this.options);
      // Try to create a lightweight notification for internal tracking. Not all clients have users.
      await notificationService.create({
        title: `Estimación enviada: ${record.estimateNumber || record.id}`,
        body: `La estimación ${record.estimateNumber || record.id} ha sido marcada como enviada.`,
        whoCreatedTheNotification: this.options.currentUser && this.options.currentUser.id ? this.options.currentUser.id : null,
      });
    } catch (e) {
      // swallow notification errors — sending should not fail because of notification
    }

    return record;
  }

  async convert(id) {
    // Convert estimate into invoice by copying relevant fields.
    const estimate = await EstimateRepository.findById(id, this.options);

    if (!estimate) {
      throw new Error('Estimate not found');
    }

    const invoicePayload: any = {
      clientId: estimate.clientId || null,
      postSiteId: estimate.postSiteId || null,
      // Use the conversion date (today) for the invoice date
      date: new Date(),
      // Set dueDate to the conversion date (today) as requested
      dueDate: new Date(),
      items: estimate.items || null,
      notes: estimate.notes || null,
      subtotal: estimate.subtotal || estimate.total || 0,
      total: estimate.total || 0,
      referenceEstimateId: estimate.id,
      title: estimate.title || `Factura from Est ${estimate.estimateNumber || estimate.id}`,
    };

    const invoiceService = new InvoiceService(this.options);
    const invoice = await invoiceService.create(invoicePayload);

    try {
      // Remove the original estimate so it no longer appears in the estimates list
      await EstimateRepository.destroy(estimate.id, this.options);
    } catch (err) {
      // Log and ignore: invoice was created successfully but estimate removal failed
      // Higher-level callers can reconcile if needed
      // eslint-disable-next-line no-console
      console.error('Failed to remove estimate after conversion', err);
    }

    return invoice;
  }

  async exportToFile(id, format = 'pdf') {
    if (!['pdf'].includes(format)) {
      throw new Error('Formato no soportado');
    }

    const estimate = await EstimateRepository.findById(id, this.options);

    if (!estimate) throw new Error('Estimate not found');
    // Build a PDF that mirrors the preview layout: header, client/site cards, items table, totals
    const doc = new PDFDocument({ size: 'A4', margin: 40 });
    const buffers: any[] = [];
    doc.on('data', (chunk) => buffers.push(chunk));
    const endPromise = new Promise((resolve) => doc.on('end', () => resolve(Buffer.concat(buffers))));

    // Common measurements
    const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const gap = 12;

    // Top area: tenant header, then left info card + right totals/status
    const leftWidth = pageWidth * 0.62;
    const rightWidth = pageWidth - leftWidth - gap;
    const startX = doc.x;
    let y = doc.y;

    // Precompute totals/right column X so tenant rendering can reference it safely
    const totalsX = startX + leftWidth + gap;

    // Tenant / business header (render at very top, aligned right)
    try {
      const tenant = SequelizeRepository.getCurrentTenant(this.options) || null;
      if (tenant) {
        const tenantName = tenant.companyName || tenant.name || tenant.title || '';
        const tenantLines: string[] = [];
        if (tenant.address) tenantLines.push(typeof tenant.address === 'string' ? tenant.address : (tenant.address.street || ''));
        if (tenant.phone) tenantLines.push(`Tel: ${tenant.phone}`);
        if (tenant.email) tenantLines.push(tenant.email);

        // Render on the right column area
        const tenantRightX = totalsX; // same X as the totals box / right column
        const tenantRightW = rightWidth;

        if (tenantName) {
          doc.font('Helvetica-Bold').fontSize(14).fillColor('#0f172a').text(tenantName, tenantRightX, y, { width: tenantRightW, align: 'right' });
          y += 20;
        }

        if (tenantLines.length) {
          doc.font('Helvetica').fontSize(10).fillColor('#374151').text(tenantLines.join('\n'), tenantRightX, y, { width: tenantRightW, align: 'right' });
          y += tenantLines.length * 12 + 6;
        }

        // small gap after tenant block
        y += 8;
      }
    } catch (err) {
      // ignore tenant retrieval errors — continue rendering
    }

    // Left small card
    doc.rect(startX, y, leftWidth, 64).lineWidth(0.5).stroke('#e5e7eb');
    doc.font('Helvetica-Bold').fontSize(12).fillColor('#0f172a').text('Estimación', startX + 12, y + 12);

    // Right totals box
    doc.rect(totalsX, y, rightWidth, 64).lineWidth(0.5).stroke('#e5e7eb');
    doc.font('Helvetica').fontSize(10).fillColor('#6b7280').text('Total General', totalsX + 12, y + 10);
    doc.font('Helvetica-Bold').fontSize(18).fillColor('#111827').text(Number(estimate.total || 0).toFixed(2), totalsX + 12, y + 26);

    // Status badge
    const badgeText = (estimate.status || 'Borrador');
    const badgeW = 86;
    const badgeH = 24;
    const badgeX = totalsX + rightWidth - badgeW - 12;
    const badgeY = y + 18;
    doc.roundedRect(badgeX, badgeY, badgeW, badgeH, 4).lineWidth(0.5).stroke('#e5e7eb');
    doc.font('Helvetica').fontSize(9).fillColor('#374151').text(badgeText, badgeX, badgeY + 6, { width: badgeW, align: 'center' });

    // Move below top area
    y += 80;
    doc.moveTo(startX, y - 8);

    // Two-column section: left client/site, right title + business info
    const colLeftW = leftWidth;
    const colRightW = rightWidth;

    // Left column - Client (compact: only name to avoid duplicating full contact info)
    const client = estimate.rawClient || (estimate.client && typeof estimate.client === 'object' ? estimate.client : null);
    const clientName = client ? (client.name || client.companyName || client.fullName || '') : (typeof estimate.client === 'string' ? estimate.client : '—');
    // omit client name in header (show only inside billing box)
    let cursorY = y;

    // Sitio (postSite) — load if available, but do not render here (we'll show details in billing box)
    let site = estimate.rawSite || estimate.postSite || estimate.site || estimate.post_site || null;
    if (!site && estimate.postSiteId) {
      try {
        // bypass permission validation when loading the postSite for PDF export
        site = await BusinessInfoRepository.findById(estimate.postSiteId, { ...this.options, bypassPermissionValidation: true });
      } catch (err) {
        // ignore missing site — keep site null
      }
    }

    // Right column - Title and company info
    const rightX = startX + colLeftW + gap;
    doc.font('Helvetica-Bold').fontSize(26).fillColor('#0f172a').text('Presupuesto', rightX, y, { width: colRightW, align: 'right' });
    const companyName = (estimate.rawSite && (estimate.rawSite.businessName || estimate.rawSite.name)) || (estimate.postSite && estimate.postSite.name) || '';
    const companyContact = (estimate.rawSite && ((estimate.rawSite.address && (typeof estimate.rawSite.address === 'string' ? estimate.rawSite.address : (estimate.rawSite.address.street || ''))) || estimate.rawSite.phone || estimate.rawSite.email)) || '';
    if (companyName) doc.font('Helvetica').fontSize(12).fillColor('#6b7280').text(companyName, rightX, y + 40, { width: colRightW, align: 'right' });
    if (companyContact) doc.font('Helvetica').fontSize(11).fillColor('#374151').text(companyContact, rightX, y + 60, { width: colRightW, align: 'right' });

    // Move below two-column area — ensure a minimum spacing under the header area
    doc.y = y + 120;

    // Middle boxed area: billing (left) and estimate meta (right)
    const midBoxHeight = 120;
    const midBoxX = startX;
    const midBoxY = doc.y;
    doc.roundedRect(midBoxX, midBoxY, pageWidth, midBoxHeight, 4).lineWidth(0.5).stroke('#e5e7eb');
    const innerPad = 12;

    // Left: Facturar a / Billing to
    const billingX = midBoxX + innerPad;
    const billingY = midBoxY + innerPad;
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#6b7280').text('Facturar a', billingX, billingY);
    doc.font('Helvetica-Bold').fontSize(12).fillColor('#111827').text(clientName || '-', billingX, billingY + 16);
    const billingLines: string[] = [];
    // Client contact details
    if (client) {
      if (client.address) billingLines.push(typeof client.address === 'string' ? client.address : (client.address.street || ''));
      if (client.phone) billingLines.push(`Tel: ${client.phone}`);
      if (client.email) billingLines.push(client.email);
    }
    // Append site contact details (if different), separated by a blank line
    if (site) {
      const siteLines: string[] = [];
      if (site.companyName) siteLines.push(site.companyName);
      if (site.address) siteLines.push(typeof site.address === 'string' ? site.address : (site.address.street || ''));
      if (site.phone) siteLines.push(`Tel: ${site.phone}`);
      const siteEmail = site.email || site.contactEmail || site.contact_email || site.contactEmailAddress || '';
      if (siteEmail) siteLines.push(siteEmail);
      if (siteLines.length) {
        if (billingLines.length) billingLines.push('');
        billingLines.push(...siteLines);
      }
    }
    if (billingLines.length) {
      doc.font('Helvetica').fontSize(10).fillColor('#374151').text(billingLines.join('\n'), billingX, billingY + 36, { width: colLeftW - innerPad });
    }

    // Right: metadata labels and values
    const metaX = midBoxX + pageWidth - 260 - innerPad;
    const metaY = midBoxY + innerPad;
    const metaLabelW = 140;
    const metaValueW = 120;
    doc.font('Helvetica').fontSize(10).fillColor('#6b7280').text('Número de Presupuesto', metaX, metaY, { width: metaLabelW, align: 'left' });
    doc.font('Helvetica').fontSize(10).fillColor('#111827').text(estimate.estimateNumber || '-', metaX + metaLabelW + 6, metaY, { width: metaValueW, align: 'right' });

    doc.font('Helvetica').fontSize(10).fillColor('#6b7280').text('Número PO/SO', metaX, metaY + 18, { width: metaLabelW, align: 'left' });
    doc.font('Helvetica').fontSize(10).fillColor('#111827').text(estimate.poNumber || '-', metaX + metaLabelW + 6, metaY + 18, { width: metaValueW, align: 'right' });

    doc.font('Helvetica').fontSize(10).fillColor('#6b7280').text('Fecha del Presupuesto', metaX, metaY + 36, { width: metaLabelW, align: 'left' });
    const dateStr = estimate.date ? (new Date(estimate.date)).toLocaleDateString() : '-';
    doc.font('Helvetica').fontSize(10).fillColor('#111827').text(dateStr, metaX + metaLabelW + 6, metaY + 36, { width: metaValueW, align: 'right' });

    doc.font('Helvetica').fontSize(10).fillColor('#6b7280').text('Fecha de Expiración', metaX, metaY + 54, { width: metaLabelW, align: 'left' });
    const expStr = estimate.expiryDate ? (new Date(estimate.expiryDate)).toLocaleDateString() : '-';
    doc.font('Helvetica').fontSize(10).fillColor('#111827').text(expStr, metaX + metaLabelW + 6, metaY + 54, { width: metaValueW, align: 'right' });

    // Move cursor below middle box (reduced gap)
    doc.y = midBoxY + midBoxHeight + 6;

    // Items table inside a rounded box with header background
    const items = Array.isArray(estimate.items) ? estimate.items : [];
    // compute a global tax percent fallback from estimate totals if individual item tax missing
    let globalTaxPercent: number | null = null;
    if (estimate.taxPercent != null) {
      globalTaxPercent = Number(estimate.taxPercent);
    } else if (estimate.subtotal && estimate.total && Number(estimate.subtotal) > 0) {
      const computed = ((Number(estimate.total) / Number(estimate.subtotal)) - 1) * 100;
      // round to 2 decimals
      globalTaxPercent = Math.round(computed * 100) / 100;
    }
    const itemsBoxX = startX;
    const itemsBoxY = doc.y;
    // approximate height; allow growing across pages
    const itemsBoxH = Math.max(80, items.length * 22 + 80);
    doc.roundedRect(itemsBoxX, itemsBoxY, pageWidth, itemsBoxH, 4).lineWidth(0.5).stroke('#e5e7eb');

    // Header background
    const headerH = 28;
    doc.rect(itemsBoxX, itemsBoxY, pageWidth, headerH).fill('#f8fafc');
    // draw thin divider under header
    doc.moveTo(itemsBoxX, itemsBoxY + headerH).lineTo(itemsBoxX + pageWidth, itemsBoxY + headerH).lineWidth(0.5).stroke('#e5e7eb');

    // Table columns: Artículo, Cantidad, Tasa, Impuesto, Monto
    const colArticulo = pageWidth * 0.50;
    const colCantidad = pageWidth * 0.12;
    const colTasa = pageWidth * 0.12;
    const colImpuesto = pageWidth * 0.13;
    // give extra padding for the amount column to avoid clipping at the right edge
    const colMonto = pageWidth - (colArticulo + colCantidad + colTasa + colImpuesto) - 12;

    const headerX = itemsBoxX + 8;
    const headerY = itemsBoxY + 6;
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#374151');
    doc.text('Artículo', headerX, headerY, { width: colArticulo - 8 });
    doc.text('Cantidad', headerX + colArticulo, headerY, { width: colCantidad - 8, align: 'right' });
    doc.text('Tasa', headerX + colArticulo + colCantidad, headerY, { width: colTasa - 8, align: 'right' });
    doc.text('Impuesto', headerX + colArticulo + colCantidad + colTasa, headerY, { width: colImpuesto - 8, align: 'right' });
    doc.text('Monto', headerX + colArticulo + colCantidad + colTasa + colImpuesto, headerY, { width: colMonto - 8, align: 'right' });

    // Items rows
    doc.font('Helvetica').fontSize(10).fillColor('#111827');
    let cursor = itemsBoxY + headerH + 8;
    for (const it of items) {
      const desc = it.description || it.name || '';
      const qty = it.quantity != null ? it.quantity : (it.qty || 1);
      const unit = it.price != null ? it.price : (it.unitPrice || it.rate || 0);
      // Determine tax percent: prefer item.taxPercent, then item.tax.percent, then estimate/global fallback
      let taxPercent: number | null = null;
      if (it && it.taxPercent != null) {
        taxPercent = Number(it.taxPercent);
      } else if (it && it.tax && it.tax.percent != null) {
        taxPercent = Number(it.tax.percent);
      } else if (globalTaxPercent != null) {
        taxPercent = Number(globalTaxPercent);
      }
      const lineTotal = (Number(qty) * Number(unit)) || 0;

      if (cursor > doc.page.height - 140) {
        doc.addPage();
        cursor = doc.y;
      }

      doc.text(desc, headerX, cursor, { width: colArticulo - 8 });
      doc.text(String(qty), headerX + colArticulo, cursor, { width: colCantidad - 8, align: 'right' });
      doc.text(`$${Number(unit).toFixed(2)}`, headerX + colArticulo + colCantidad, cursor, { width: colTasa - 8, align: 'right' });
      doc.text((taxPercent != null ? `${taxPercent}%` : '-'), headerX + colArticulo + colCantidad + colTasa, cursor, { width: colImpuesto - 8, align: 'right' });
      // right-pad the amount a bit more
      doc.text(`$${Number(lineTotal).toFixed(2)}`, headerX + colArticulo + colCantidad + colTasa + colImpuesto, cursor, { width: colMonto - 16, align: 'right' });

      cursor += 20;
    }

    // Totals inside items box (right aligned)
    const totalsTop = (cursor + 6);
    // use fixed offsets inside the items box so totals stay inside the rounded box and aligned
    const totalsLabelW = 120;
    const totalsValueW = 100;
    const totalsLabelX = itemsBoxX + pageWidth - totalsLabelW - totalsValueW - 24; // left edge of the label
    const totalsValueX = totalsLabelX + totalsLabelW + 12; // a bit of gap
    doc.font('Helvetica').fontSize(10).fillColor('#6b7280').text('Subtotal', totalsLabelX, totalsTop, { width: totalsLabelW, align: 'right' });
    doc.font('Helvetica').fontSize(10).fillColor('#111827').text(`$${(estimate.subtotal != null ? Number(estimate.subtotal).toFixed(2) : Number(estimate.total || 0).toFixed(2))}`, totalsValueX, totalsTop, { width: totalsValueW, align: 'right' });

    doc.font('Helvetica-Bold').fontSize(12).fillColor('#111827').text('Total', totalsLabelX, totalsTop + 18, { width: totalsLabelW, align: 'right' });
    doc.font('Helvetica-Bold').fontSize(12).text(`$${Number(estimate.total || 0).toFixed(2)}`, totalsValueX, totalsTop + 18, { width: totalsValueW, align: 'right' });

    // Footer notes
    if (estimate.notes) {
      const footerY = doc.page.height - 120;
      doc.moveTo(startX, footerY - 12).lineTo(startX + pageWidth, footerY - 12).lineWidth(0.5).stroke('#e5e7eb');
      doc.font('Helvetica').fontSize(10).fillColor('#6b7280').text('Notas', startX, footerY, { width: pageWidth });
      doc.font('Helvetica').fontSize(9).fillColor('#111827').text(String(estimate.notes), startX, footerY + 18, { width: pageWidth });
    }

    doc.end();

    const buffer: Buffer = await endPromise as Buffer;
    return { buffer, mimeType: 'application/pdf' };
  }
}
