import crypto from 'crypto';
import { IServiceOptions } from './IServiceOptions';
import InvoiceRepository from '../database/repositories/invoiceRepository';
import SequelizeRepository from '../database/repositories/sequelizeRepository';

export default class PaymentService {
  options: IServiceOptions;

  constructor(options) {
    this.options = options;
  }

  // Create a payment by appending it to the invoice.payments JSON array.
  // This avoids creating a separate `payments` table. The invoice must exist.
  async create(data) {
    if (!data || !data.invoiceId) {
      throw Object.assign(new Error('invoiceId is required'), { code: 400 });
    }

    const transaction = await SequelizeRepository.createTransaction(this.options.database);
    try {
      // ensure invoice exists and belongs to tenant
      const invoice = await InvoiceRepository.findById(data.invoiceId, { ...this.options, transaction });

      const currentUser = SequelizeRepository.getCurrentUser(this.options) || null;
      const tenant = SequelizeRepository.getCurrentTenant(this.options);

      // Lock the invoice row for this read-modify-write so two concurrent payment
      // posts can't both read the same payments array (lost update) or jointly
      // bypass the over-total check.
      const lockedInvoice = await this.options.database.invoice.findOne({
        where: { id: data.invoiceId, tenantId: tenant.id },
        lock: transaction.LOCK.UPDATE,
        transaction,
      });

      const newPayment = {
        id: crypto.randomUUID(),
        invoiceId: data.invoiceId,
        amount: Number(data.amount || 0),
        date: data.date || new Date().toISOString(),
        method: data.method || null,
        note: data.note || data.reference || null,
        createdById: currentUser ? currentUser.id : null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const existing = Array.isArray(lockedInvoice && lockedInvoice.payments)
        ? lockedInvoice.payments
        : (Array.isArray(invoice.payments) ? invoice.payments : []);
      // Prevent creating a payment that would make total payments exceed the invoice total
      const existingSum = existing.reduce((acc, p) => acc + Number(p.amount || p.total || p.paid || 0), 0);
      const invoiceTotal = Number(invoice.total || 0);
      const proposedSum = existingSum + Number(newPayment.amount || 0);
      // allow tiny rounding epsilon
      if (proposedSum > invoiceTotal + 0.005) {
        throw Object.assign(new Error('El total de los pagos no puede exceder el total de la factura'), { code: 400 });
      }

      const updatedPayments = [newPayment, ...existing];

      // Update invoice with new payments array
      await InvoiceRepository.update(data.invoiceId, { payments: updatedPayments }, { ...this.options, transaction });

      await SequelizeRepository.commitTransaction(transaction);

      return newPayment;
    } catch (err) {
      await SequelizeRepository.rollbackTransaction(transaction);
      throw err;
    }
  }
}
