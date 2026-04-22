/**
 * @openapi {
 *  "summary": "Get pending payments for invoice",
 *  "description": "Return the invoice total, payments received and pending amount.",
 *  "responses": { "200": { "description": "Pending payments object" } }
 * }
 */
import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import InvoiceService from '../../services/invoiceService';

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

export default async (req, res, next) => {
  try {
    new PermissionChecker(req).validateHas(
      Permissions.values.invoiceRead,
    );

    const invoice = await new InvoiceService(req).findById(req.params.id);

    const paymentsArr = Array.isArray(invoice.payments) ? invoice.payments : (Array.isArray(invoice.rawPayments) ? invoice.rawPayments : []);

    const totalPaid = (paymentsArr || []).reduce((acc: number, p: any) => {
      const v = parseNumeric(p?.amount ?? p?.paid ?? p?.total ?? p?.paidAmount ?? 0);
      return acc + v;
    }, 0);

    const invoiceTotal = Number(invoice.total || 0) || 0;
    const pending = Math.max(0, Number((invoiceTotal - totalPaid).toFixed(2)));

    const payload = {
      invoiceId: invoice.id,
      total: invoiceTotal,
      paid: Number(totalPaid.toFixed(2)),
      pending,
      payments: paymentsArr,
    };

    await ApiResponseHandler.success(req, res, payload);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
