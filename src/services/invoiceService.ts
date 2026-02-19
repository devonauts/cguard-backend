import Error400 from '../errors/Error400';
import SequelizeRepository from '../database/repositories/sequelizeRepository';
import { getConfig } from '../config';
import { IServiceOptions } from './IServiceOptions';
import InvoiceRepository from '../database/repositories/invoiceRepository';
import ClientAccountRepository from '../database/repositories/clientAccountRepository';
import BusinessInfoRepository from '../database/repositories/businessInfoRepository';
import NotificationService from './notificationService';
import sendgridMail from '@sendgrid/mail';
import EmailSender from './emailSender';


export default class InvoiceService {
  options: IServiceOptions;

  constructor(options: IServiceOptions) {
    this.options = options;
  }

  async _isSentAndFullyPaid(record, id) {
    try {
      if (!record) return false;
      const status = record.status || '';
      if (String(status).toLowerCase() !== 'enviado') return false;

      // compute effectivePaid similar to send()
      const paymentsArr = Array.isArray(record.payments) ? record.payments : (Array.isArray(record.rawPayments) ? record.rawPayments : []);
      const parseNumeric = (v: any) => {
        if (v == null) return 0;
        if (typeof v === 'number') return v;
        if (typeof v === 'string') {
          const cleaned = String(v).replace(/[^0-9.-]+/g, '');
          const n = Number(cleaned);
          return isNaN(n) ? 0 : n;
        }
        const n = Number(v);
        return isNaN(n) ? 0 : n;
      };

      const totalPaid = (paymentsArr || []).reduce((acc: number, p: any) => {
        const v = parseNumeric(p?.amount ?? p?.paid ?? p?.total ?? p?.paidAmount ?? 0);
        return acc + v;
      }, 0);

      const topPaid = parseNumeric(record.paidAmount ?? record.paid ?? record.paidTotal ?? 0) || 0;
      let effectivePaid = (totalPaid > 0) ? totalPaid : topPaid;

      if (!effectivePaid || effectivePaid === 0) {
        try {
          const tenant = SequelizeRepository.getCurrentTenant(this.options);
          const paymentModel = this.options && this.options.database && this.options.database.payment ? this.options.database.payment : null;
          if (paymentModel) {
            const payRows = await paymentModel.findAll({ where: { invoiceId: id, tenantId: tenant.id } });
            if (Array.isArray(payRows) && payRows.length) {
              const sum = payRows.reduce((acc: number, p: any) => {
                const val = Number(p.amount ?? p.paid ?? p.total ?? 0);
                return acc + (isNaN(val) ? 0 : val);
              }, 0);
              effectivePaid = sum;
            }
          }
        } catch (e) {
          // ignore fallback errors
        }
      }

      const invoiceTotal = Number(record.total || 0) || 0;
      const EPS = 0.005;
      return invoiceTotal > 0 && (effectivePaid + EPS) >= invoiceTotal;
    } catch (e) {
      return false;
    }
  }

  async create(data) {
    const transaction = await SequelizeRepository.createTransaction(this.options.database);

    try {
      data.clientId = await ClientAccountRepository.filterIdInTenant(data.clientId, { ...this.options, transaction });
      data.postSiteId = await BusinessInfoRepository.filterIdInTenant(data.postSiteId, { ...this.options, transaction });

      // Auto-generate invoiceNumber if not provided by querying existing invoices per tenant
      const generateInvoiceNumber = async () => {
        const tenant = SequelizeRepository.getCurrentTenant(this.options);
        const format = (getConfig() && getConfig().INVOICE_NUMBER_FORMAT) || 'numeric';

        if (format === 'year') {
          const year = (new Date()).getFullYear();
          // Find the max numeric suffix for invoiceNumber like 'YYYY-XXXX'
          const sql = `SELECT MAX(CAST(SUBSTRING_INDEX(invoiceNumber, '-', -1) AS UNSIGNED)) as max FROM invoices WHERE tenantId = :tenantId AND invoiceNumber LIKE :likePattern`;
          const replacements = { tenantId: tenant.id, likePattern: `${year}-%` };
          try {
            const rows: any[] = await this.options.database.sequelize.query(sql, { replacements, type: this.options.database.sequelize.QueryTypes.SELECT });
            const result = rows && rows.length ? rows[0] : null;
            const max = result && result.max ? Number(result.max) : 0;
            const nextNumber = max + 1;
            const padded = String(nextNumber).padStart(4, '0');
            return `${year}-${padded}`;
          } catch (err) {
            const nextNumber = 1;
            return `${year}-${String(nextNumber).padStart(4, '0')}`;
          }
        }

        // numeric format: take MAX CAST(invoiceNumber AS UNSIGNED) for tenant
        const sql = `SELECT MAX(CAST(invoiceNumber AS UNSIGNED)) as max FROM invoices WHERE tenantId = :tenantId`;
        const replacements = { tenantId: SequelizeRepository.getCurrentTenant(this.options).id };
        try {
          const rows: any[] = await this.options.database.sequelize.query(sql, { replacements, type: this.options.database.sequelize.QueryTypes.SELECT });
          const result = rows && rows.length ? rows[0] : null;
          const max = result && result.max ? Number(result.max) : 0;
          const nextNumber = max + 1;
          return String(nextNumber);
        } catch (err) {
          return '1';
        }
      };

      if (!data.invoiceNumber) {
        // attempt create with retries on unique constraint
        let attempts = 0;
        const maxAttempts = 5;
        let lastError: any = null;
        while (attempts < maxAttempts) {
          attempts += 1;
          data.invoiceNumber = await generateInvoiceNumber();
          try {
            const record = await InvoiceRepository.create(data, { ...this.options, transaction });
            await SequelizeRepository.commitTransaction(transaction);
            return record;
          } catch (err: any) {
            lastError = err;
            const name = err && err.name ? err.name : '';
            if (name === 'SequelizeUniqueConstraintError' || (err && err.errors && err.errors[0] && err.errors[0].message && String(err.errors[0].message).includes('invoiceNumber'))) {
              // retry generating a new number
              continue;
            }
            throw err;
          }
        }
        throw lastError || new Error('Failed to create invoice due to unique constraint');
      }

      // client provided invoiceNumber: create normally
      const record = await InvoiceRepository.create(data, { ...this.options, transaction });

      await SequelizeRepository.commitTransaction(transaction);

      return record;
    } catch (error: any) {
      await SequelizeRepository.rollbackTransaction(transaction);

      SequelizeRepository.handleUniqueFieldError(error, this.options.language, 'invoice');

      throw error;
    }
  }

  async update(id, data) {
    const transaction = await SequelizeRepository.createTransaction(this.options.database);

    try {
      // Prevent editing if invoice already sent and fully paid
      const existing = await InvoiceRepository.findById(id, { ...this.options, transaction, bypassPermissionValidation: true });
      if (await this._isSentAndFullyPaid(existing, id)) {
        throw new Error400(this.options.language, 'invoice.errors.cannotModifySentPaid');
      }

      data.clientId = await ClientAccountRepository.filterIdInTenant(data.clientId, { ...this.options, transaction });
      data.postSiteId = await BusinessInfoRepository.filterIdInTenant(data.postSiteId, { ...this.options, transaction });

      const record = await InvoiceRepository.update(id, data, { ...this.options, transaction });

      await SequelizeRepository.commitTransaction(transaction);

      return record;
    } catch (error) {
      await SequelizeRepository.rollbackTransaction(transaction);
      SequelizeRepository.handleUniqueFieldError(error, this.options.language, 'invoice');
      throw error;
    }
  }

  async destroyAll(ids) {
    const transaction = await SequelizeRepository.createTransaction(this.options.database);

    try {
      for (const id of ids) {
        const existing = await InvoiceRepository.findById(id, { ...this.options, transaction, bypassPermissionValidation: true });
        if (await this._isSentAndFullyPaid(existing, id)) {
          throw new Error400(this.options.language, 'invoice.errors.cannotModifySentPaid');
        }
        await InvoiceRepository.destroy(id, { ...this.options, transaction });
      }

      await SequelizeRepository.commitTransaction(transaction);
    } catch (error) {
      await SequelizeRepository.rollbackTransaction(transaction);
      throw error;
    }
  }

  async findById(id) {
    return InvoiceRepository.findById(id, this.options);
  }

  async findAllAutocomplete(search, limit) {
    return InvoiceRepository.findAllAutocomplete(search, limit, this.options);
  }

  async findAndCountAll(args) {
    return InvoiceRepository.findAndCountAll(args, this.options);
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
    const count = await InvoiceRepository.count({ importHash }, this.options);
    return count > 0;
  }

  async exportToFile(id, format = 'pdf') {
    if (!['pdf'].includes(format)) {
      throw new Error('Formato no soportado');
    }

    const invoice = await InvoiceRepository.findById(id, { ...this.options, bypassPermissionValidation: true });

    if (!invoice) throw new Error('Invoice not found');
    const PDFDocument = require('pdfkit');
    const doc = new PDFDocument({ size: 'A4', margin: 40 });
    const buffers: any[] = [];
    doc.on('data', (chunk) => buffers.push(chunk));
    const endPromise = new Promise((resolve) => doc.on('end', () => resolve(Buffer.concat(buffers))));

    const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const gap = 12;
    const leftWidth = pageWidth * 0.62;
    const rightWidth = pageWidth - leftWidth - gap;
    const startX = doc.x;
    let y = doc.y;

    // Tenant header (right column)
    try {
      const tenant = SequelizeRepository.getCurrentTenant(this.options) || null;
      if (tenant) {
        const tenantName = tenant.companyName || tenant.name || tenant.title || '';
        const tenantLines: string[] = [];
        if (tenant.address) tenantLines.push(typeof tenant.address === 'string' ? tenant.address : (tenant.address.street || ''));
        if (tenant.phone) tenantLines.push(`Tel: ${tenant.phone}`);
        if (tenant.email) tenantLines.push(tenant.email);

        const tenantRightX = startX + leftWidth + gap;
        const tenantRightW = rightWidth;

        if (tenantName) {
          doc.font('Helvetica-Bold').fontSize(14).fillColor('#0f172a').text(tenantName, tenantRightX, y, { width: tenantRightW, align: 'right' });
          y += 20;
        }

        if (tenantLines.length) {
          doc.font('Helvetica').fontSize(10).fillColor('#374151').text(tenantLines.join('\n'), tenantRightX, y, { width: tenantRightW, align: 'right' });
          y += tenantLines.length * 12 + 6;
        }

        y += 8;
      }
    } catch (err) {
      // ignore
    }

    // Large title on the top-left
    doc.font('Helvetica-Bold').fontSize(26).fillColor('#0f172a').text('Factura', startX, y, { width: leftWidth, align: 'left' });
    y += 36;

    // Pre-compute totals from invoice items to ensure per-line and totals match
    const itemsForTotals = Array.isArray(invoice.items) ? invoice.items : [];
    const computedSubtotal = itemsForTotals.reduce((acc: number, it: any) => acc + (Number(it.quantity || 1) * Number(it.rate ?? it.price ?? (it.service && (it.service.price ?? it.service.amount)) ?? 0)), 0);
    const computedTotal = itemsForTotals.reduce((acc: number, it: any) => {
      const qty = Number(it.quantity || 1);
      const rate = Number(it.rate ?? it.price ?? (it.service && (it.service.price ?? it.service.amount)) ?? 0);
      const line = qty * rate;
      const tax = Number(it.taxRate ?? it.tax ?? (it.service && (it.service.taxRate ?? it.service.tax?.rate)) ?? 0);
      const taxAmount = tax ? (line * (tax / 100)) : 0;
      return acc + line + taxAmount;
    }, 0);

    // Right totals box
    const totalsX = startX + leftWidth + gap;
    doc.rect(totalsX, y, rightWidth, 64).lineWidth(0.5).stroke('#e5e7eb');
    doc.font('Helvetica').fontSize(10).fillColor('#6b7280').text('Total General', totalsX + 12, y + 10);
    doc.font('Helvetica-Bold').fontSize(18).fillColor('#111827').text(Number(computedTotal || invoice.total || 0).toFixed(2), totalsX + 12, y + 26);

    const badgeText = (invoice.status || 'Borrador');
    const badgeW = 86;
    const badgeH = 24;
    const badgeX = totalsX + rightWidth - badgeW - 12;
    const badgeY = y + 18;
    doc.roundedRect(badgeX, badgeY, badgeW, badgeH, 4).lineWidth(0.5).stroke('#e5e7eb');
    doc.font('Helvetica').fontSize(9).fillColor('#374151').text(badgeText, badgeX, badgeY + 6, { width: badgeW, align: 'center' });

    // increase gap after header area
    y += 12;

    // Payments received box (under the title, left column)
    const payments = Array.isArray(invoice.payments) ? invoice.payments : (invoice.rawPayments || []);
    const maxPayRows = Math.min(3, (payments || []).length);
    const payRowH = 18;
    const payHeaderH = 22;
    const payBoxH = payHeaderH + (maxPayRows * payRowH) + (maxPayRows ? 8 : 18);
    doc.roundedRect(startX, y, leftWidth, payBoxH, 4).lineWidth(0.5).stroke('#e5e7eb');
    doc.font('Helvetica-Bold').fontSize(12).fillColor('#111827').text('Pagos recibidos', startX + 8, y + 6);
    if (Array.isArray(payments) && payments.length) {
      let py = y + payHeaderH;
      doc.font('Helvetica').fontSize(10).fillColor('#374151');
      for (let i = 0; i < maxPayRows; i++) {
        const p = payments[i];
        const pDate = p.date ? (new Date(p.date)).toLocaleDateString() : (p.createdAt ? (new Date(p.createdAt)).toLocaleDateString() : '-');
        const pMethod = p.method || p.paymentMethod || p.type || '-';
        const pAmount = Number(p.amount ?? p.total ?? p.paid ?? 0).toFixed(2);
        doc.text(`${pDate} • ${pMethod} • $${pAmount}`, startX + 8, py, { width: leftWidth - 16 });
        py += payRowH;
      }
    } else {
      doc.font('Helvetica').fontSize(10).fillColor('#9ca3af').text('No hay pagos registrados', startX + 8, y + payHeaderH + 6);
    }

    y += payBoxH + 12;
    doc.y = y;

    // Middle boxed area: billing (left) and invoice meta (right)
    const midBoxHeight = 120;
    const midBoxX = startX;
    const midBoxY = doc.y;
    doc.roundedRect(midBoxX, midBoxY, pageWidth, midBoxHeight, 4).lineWidth(0.5).stroke('#e5e7eb');
    const innerPad = 12;

    const billingX = midBoxX + innerPad;
    const billingY = midBoxY + innerPad;
    // client name
    const client = invoice.rawClient || (invoice.client && typeof invoice.client === 'object' ? invoice.client : null);
    const clientName = client
      ? (
        (client.fullName && String(client.fullName).trim())
        || ((String(client.firstName || '').trim() + ' ' + String(client.lastName || '').trim()).trim())
        || client.name
        || client.companyName
        || ''
      )
      : (typeof invoice.client === 'string' ? invoice.client : '-');
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#6b7280').text('Facturar a', billingX, billingY);
    doc.font('Helvetica-Bold').fontSize(12).fillColor('#111827').text(clientName || '-', billingX, billingY + 16);
    const billingLines: string[] = [];
    if (client) {
      if (client.address) billingLines.push(typeof client.address === 'string' ? client.address : (client.address.street || ''));
      if (client.phone) billingLines.push(`Tel: ${client.phone}`);
      if (client.email) billingLines.push(client.email);
    }

    let site = invoice.rawSite || invoice.postSite || invoice.site || invoice.post_site || null;
    if (!site && invoice.postSiteId) {
      try {
        site = await BusinessInfoRepository.findById(invoice.postSiteId, { ...this.options, bypassPermissionValidation: true });
      } catch (err) {
        // ignore
      }
    }
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
      doc.font('Helvetica').fontSize(10).fillColor('#374151').text(billingLines.join('\n'), billingX, billingY + 36, { width: leftWidth - innerPad });
    }

    const metaX = midBoxX + pageWidth - 260 - innerPad;
    const metaY = midBoxY + innerPad;
    const metaLabelW = 140;
    const metaValueW = 120;
    doc.font('Helvetica').fontSize(10).fillColor('#6b7280').text('Número de Factura', metaX, metaY, { width: metaLabelW, align: 'left' });
    doc.font('Helvetica').fontSize(10).fillColor('#111827').text(invoice.invoiceNumber || '-', metaX + metaLabelW + 6, metaY, { width: metaValueW, align: 'right' });

    doc.font('Helvetica').fontSize(10).fillColor('#6b7280').text('Número PO/SO', metaX, metaY + 18, { width: metaLabelW, align: 'left' });
    doc.font('Helvetica').fontSize(10).fillColor('#111827').text(invoice.poSoNumber || invoice.poNumber || '-', metaX + metaLabelW + 6, metaY + 18, { width: metaValueW, align: 'right' });

    doc.font('Helvetica').fontSize(10).fillColor('#6b7280').text('Fecha', metaX, metaY + 36, { width: metaLabelW, align: 'left' });
    const dateStr = invoice.date ? (new Date(invoice.date)).toLocaleDateString() : '-';
    doc.font('Helvetica').fontSize(10).fillColor('#111827').text(dateStr, metaX + metaLabelW + 6, metaY + 36, { width: metaValueW, align: 'right' });

    doc.font('Helvetica').fontSize(10).fillColor('#6b7280').text('Pago debido', metaX, metaY + 54, { width: metaLabelW, align: 'left' });
    const dueStr = invoice.dueDate ? (new Date(invoice.dueDate)).toLocaleDateString() : '-';
    doc.font('Helvetica').fontSize(10).fillColor('#111827').text(dueStr, metaX + metaLabelW + 6, metaY + 54, { width: metaValueW, align: 'right' });

    doc.y = midBoxY + midBoxHeight + 6;

    // Items table
    const items = Array.isArray(invoice.items) ? invoice.items : [];
    let globalTaxPercent: number | null = null;
    if (invoice.taxPercent != null) {
      globalTaxPercent = Number(invoice.taxPercent);
    } else if (invoice.subtotal && invoice.total && Number(invoice.subtotal) > 0) {
      const computed = ((Number(invoice.total) / Number(invoice.subtotal)) - 1) * 100;
      globalTaxPercent = Math.round(computed * 100) / 100;
    }

    const itemsBoxX = startX;
    const itemsBoxY = doc.y;
    const itemsBoxH = Math.max(80, items.length * 22 + 80);
    doc.roundedRect(itemsBoxX, itemsBoxY, pageWidth, itemsBoxH, 4).lineWidth(0.5).stroke('#e5e7eb');
    const headerH = 28;
    doc.rect(itemsBoxX, itemsBoxY, pageWidth, headerH).fill('#f8fafc');
    doc.moveTo(itemsBoxX, itemsBoxY + headerH).lineTo(itemsBoxX + pageWidth, itemsBoxY + headerH).lineWidth(0.5).stroke('#e5e7eb');

    const colArticulo = pageWidth * 0.50;
    const colCantidad = pageWidth * 0.12;
    const colTasa = pageWidth * 0.12;
    const colImpuesto = pageWidth * 0.13;
    const colMonto = pageWidth - (colArticulo + colCantidad + colTasa + colImpuesto) - 12;

    const headerX = itemsBoxX + 8;
    const headerY = itemsBoxY + 6;
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#374151');

    // header labels
    doc.text('Artículo', headerX, headerY, { width: colArticulo });
    doc.text('Cantidad', headerX + colArticulo, headerY, { width: colCantidad, align: 'left' });
    doc.text('Tasa', headerX + colArticulo + colCantidad, headerY, { width: colTasa, align: 'left' });
    doc.text('Impuesto', headerX + colArticulo + colCantidad + colTasa, headerY, { width: colImpuesto, align: 'left' });
    doc.text('Monto', headerX + colArticulo + colCantidad + colTasa + colImpuesto, headerY, { width: colMonto, align: 'right' });

    // draw rows
    let rowY = itemsBoxY + headerH + 6;
    for (const it of items) {
      const itemName = it.name || (it.service && (it.service.title || it.service.name)) || '-';
      const qty = Number(it.quantity || 1);
      const rate = Number(it.rate ?? it.price ?? (it.service && (it.service.price ?? it.service.amount)) ?? 0);
      const tax = Number(it.taxRate ?? it.tax ?? (it.service && (it.service.taxRate ?? it.service.tax?.rate)) ?? 0);
      const line = qty * rate;
      const taxAmount = tax ? (line * (tax / 100)) : 0;
      const amount = line + taxAmount;

      doc.font('Helvetica').fontSize(10).fillColor('#111827').text(itemName, headerX, rowY, { width: colArticulo });
      doc.text(String(qty), headerX + colArticulo, rowY, { width: colCantidad, align: 'left' });
      doc.text(`$${Number(rate).toFixed(2)}`, headerX + colArticulo + colCantidad, rowY, { width: colTasa, align: 'left' });
      doc.text(tax ? `${tax}%` : '-', headerX + colArticulo + colCantidad + colTasa, rowY, { width: colImpuesto, align: 'left' });
      doc.text(`$${Number(amount).toFixed(2)}`, headerX + colArticulo + colCantidad + colTasa + colImpuesto, rowY, { width: colMonto, align: 'right' });

      rowY += 22;
    }

    // Totals box at bottom right
    const totalsBoxX = itemsBoxX + pageWidth - 260;
    const totalsBoxY = itemsBoxY + itemsBoxH + 12;
    const labelW = 140;
    const valueW = 100;

    doc.font('Helvetica').fontSize(10).fillColor('#6b7280').text('Subtotal', totalsBoxX, totalsBoxY, { width: labelW, align: 'left' });
    doc.font('Helvetica').fontSize(10).fillColor('#111827').text(Number(invoice.subtotal || 0).toFixed(2), totalsBoxX + labelW + 6, totalsBoxY, { width: valueW, align: 'right' });

    doc.font('Helvetica').fontSize(10).fillColor('#6b7280').text('Impuesto', totalsBoxX, totalsBoxY + 18, { width: labelW, align: 'left' });
    const taxVal = Number((invoice.total || 0) - (invoice.subtotal || 0));
    doc.font('Helvetica').fontSize(10).fillColor('#111827').text(Number(taxVal).toFixed(2), totalsBoxX + labelW + 6, totalsBoxY + 18, { width: valueW, align: 'right' });

    doc.font('Helvetica-Bold').fontSize(12).fillColor('#111827').text('Total', totalsBoxX, totalsBoxY + 36, { width: labelW, align: 'left' });
    doc.font('Helvetica-Bold').fontSize(12).fillColor('#111827').text(Number(invoice.total || 0).toFixed(2), totalsBoxX + labelW + 6, totalsBoxY + 36, { width: valueW, align: 'right' });

    doc.end();
    await endPromise;
    // @ts-ignore
    const buffer = Buffer.concat(buffers);
    return { buffer };
  }

  async send(id) {
    const record = await InvoiceRepository.findById(id, this.options);

    if (!record) {
      throw new Error('Invoice not found');
    }

    // Ensure invoice is paid in full before allowing send
    try {
      // payments can be stored in several shapes: record.payments (JSON), record.rawPayments, or top-level paid/paidAmount
      const paymentsArr = Array.isArray(record.payments) ? record.payments : (Array.isArray(record.rawPayments) ? record.rawPayments : []);
      // Sum available payment fields defensively
      const parseNumeric = (v: any) => {
        if (v == null) return 0;
        if (typeof v === 'number') return v;
        if (typeof v === 'string') {
          const cleaned = String(v).replace(/[^0-9.-]+/g, '');
          const n = Number(cleaned);
          return isNaN(n) ? 0 : n;
        }
        const n = Number(v);
        return isNaN(n) ? 0 : n;
      };

      const totalPaid = (paymentsArr || []).reduce((acc: number, p: any) => {
        const v = parseNumeric(p?.amount ?? p?.paid ?? p?.total ?? p?.paidAmount ?? 0);
        return acc + v;
      }, 0);

      // Fallback to aggregated fields if present
      const topPaid = parseNumeric(record.paidAmount ?? record.paid ?? record.paidTotal ?? 0) || 0;
      let effectivePaid = (totalPaid > 0) ? totalPaid : topPaid;

      // If there are no embedded payments and no top-level paid amount, try to query payments table
      if (!effectivePaid || effectivePaid === 0) {
        try {
          const tenant = SequelizeRepository.getCurrentTenant(this.options);
          const paymentModel = this.options && this.options.database && this.options.database.payment ? this.options.database.payment : null;
          if (paymentModel) {
            const payRows = await paymentModel.findAll({ where: { invoiceId: id, tenantId: tenant.id } });
            if (Array.isArray(payRows) && payRows.length) {
              const sum = payRows.reduce((acc: number, p: any) => {
                const val = Number(p.amount ?? p.paid ?? p.total ?? 0);
                return acc + (isNaN(val) ? 0 : val);
              }, 0);
              effectivePaid = sum;
            }
          }
        } catch (e) {
          // ignore fallback errors — we'll rely on previous checks
        }
      }

      const invoiceTotal = Number(record.total || 0) || 0;

      const EPS = 0.005; // tolerate minor floating point rounding
      if (invoiceTotal > 0 && (effectivePaid + EPS) < invoiceTotal) {
        // helpful debug when failing validation
        // eslint-disable-next-line no-console
        console.debug('[InvoiceService.send] Validation failed: invoiceTotal=', invoiceTotal, 'effectivePaid=', effectivePaid, 'payments=', paymentsArr);
        throw new Error400(this.options.language, 'invoice.errors.notFullyPaid');
      }
    } catch (err) {
      if (err instanceof Error400) throw err;
      // any other error, rethrow as generic validation error
      throw new Error400(this.options.language, 'invoice.errors.notFullyPaid');
    }

    // Generate PDF
    let pdfBuffer: Buffer | null = null;
    try {
      const file = await this.exportToFile(id, 'pdf');
      pdfBuffer = file.buffer;
    } catch (err) {
      // If PDF generation fails, still try to proceed with notification
      pdfBuffer = null;
    }

    // Try to send email via SendGrid if configured and client email exists
    let emailSent = false;
    let emailedTo: string | null = null;
    try {
      const client = record.rawClient || (record.client && typeof record.client === 'object' ? record.client : null);
      const to = client && (client.email || client.contactEmail || client.contact_email);
      emailedTo = to || null;

      if (to && getConfig().SENDGRID_KEY && getConfig().SENDGRID_EMAIL_FROM) {
        sendgridMail.setApiKey(getConfig().SENDGRID_KEY);

        const msg: any = {
          to,
          from: getConfig().SENDGRID_EMAIL_FROM,
          subject: `Factura ${record.invoiceNumber || record.id}`,
          text: `Adjunto encontrará la factura ${record.invoiceNumber || record.id}`,
        };

        if (pdfBuffer) {
          msg.attachments = [
            {
              content: pdfBuffer.toString('base64'),
              filename: `${record.invoiceNumber || record.id}.pdf`,
              type: 'application/pdf',
              disposition: 'attachment',
            },
          ];
        }

        await sendgridMail.send(msg);
        emailSent = true;
      }
      // Fallback: use local template sender when SendGrid not configured
      if (to && !emailSent) {
        try {
          const tenant = SequelizeRepository.getCurrentTenant(this.options) || null;
          const vars: any = {
            tenant: tenant || {},
            firstName: (client && (client.firstName || client.name || client.fullName)) || '',
            lastName: (client && (client.lastName || '')) || '',
            email: (client && (client.email || client.contactEmail || client.contact_email)) || '',
            id: record.id,
            invoiceNumber: record.invoiceNumber || record.id,
            total: Number(record.total || 0).toFixed(2),
            link: `${(getConfig().APP_URL || '').replace(/\/$/, '')}/tenant/${SequelizeRepository.getCurrentTenant(this.options).id}/invoice/${id}/download?format=pdf`,
            template: 'invoice',
          };
          const sender = new EmailSender(null, vars);
          const res = await sender.sendTo(to);
          emailSent = Boolean(res);
          emailedTo = to;
        } catch (e) {
          // ignore fallback errors
          emailSent = false;
        }
      }
    } catch (err) {
      // Log and continue — sending should not crash the flow
      // eslint-disable-next-line no-console
      console.error('Failed to send invoice email', err);
      emailSent = false;
    }

    // Create lightweight notification for internal tracking
    try {
      const notificationService = new NotificationService(this.options);
      await notificationService.create({
        title: `Factura enviada: ${record.invoiceNumber || record.id}`,
        body: `La factura ${record.invoiceNumber || record.id} ha sido marcada como enviada.`,
        whoCreatedTheNotification: this.options.currentUser && this.options.currentUser.id ? this.options.currentUser.id : null,
      });
    } catch (e) {
      // swallow notification errors
    }

    // Optionally update invoice status to 'Sent'
    try {
      await InvoiceRepository.update(
        id,
        { status: 'Enviado', sentAt: new Date(), clientId: record.clientId ?? undefined, postSiteId: record.postSiteId ?? undefined },
        this.options,
      );
    } catch (e) {
      // ignore update errors
    }

    // Return structured payload with email send outcome and fresh invoice state
    const updated = await InvoiceRepository.findById(id, this.options);
    return { invoice: updated, emailSent, emailedTo };
  }
}
