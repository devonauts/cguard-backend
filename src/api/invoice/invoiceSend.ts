import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import InvoiceService from '../../services/invoiceService';

export default async (req, res, next) => {
  try {
    // Validate permission (add invoiceSend to permissions list if not present)
    new PermissionChecker(req).validateHas(
      Permissions.values.invoiceSend,
    );

    const { id } = req.params;

    const payload = await new InvoiceService(req).send(id);

    // Provide explicit confirmation message when email was sent
    const responsePayload = {
      message: payload.emailSent ? `Factura enviada a ${payload.emailedTo}` : 'Factura procesada. No se envió correo (falta configuración o email).',
      invoice: payload.invoice,
      emailSent: payload.emailSent,
      emailedTo: payload.emailedTo,
    };

    await ApiResponseHandler.success(req, res, responsePayload);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
