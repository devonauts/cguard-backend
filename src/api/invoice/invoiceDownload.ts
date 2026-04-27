import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import InvoiceService from '../../services/invoiceService';
import Roles from '../../security/roles';
import Error403 from '../../errors/Error403';

export default async (req, res, next) => {
  try {
    new PermissionChecker(req).validateHas(
      Permissions.values.estimateDownload,
    );

    const { id } = req.params;
    const format = (req.query.format as string) || 'pdf';

    if (!['pdf'].includes(format)) {
      return res.status(400).json({ message: 'Formato no soportado' });
    }

    const service = new InvoiceService(req);
    
    // First, get the invoice to validate access
    const invoice = await service.findById(id);

    // Validate that customer can only download their own invoices
    const currentUser = req.currentUser;
    const currentTenant = req.currentTenant;

    if (currentUser && currentTenant && invoice) {
      const tenantForUser = (currentUser.tenants || [])
        .filter((t) => t.status === 'active')
        .find((t) => t.tenant && t.tenant.id === currentTenant.id);

      if (tenantForUser) {
        const userRoles = tenantForUser.roles || [];
        const isCustomer = userRoles.includes(Roles.values.customer);

        if (isCustomer) {
          // Find the clientAccount associated with this user
          try {
            const clientAccount = await req.database.clientAccount.findOne({
              where: {
                userId: currentUser.id,
                tenantId: currentTenant.id,
              },
              attributes: ['id'],
            });

            const invoiceClientId = invoice.clientId || (invoice.client && invoice.client.id);
            
            if (!clientAccount || !clientAccount.id || invoiceClientId !== clientAccount.id) {
              console.log(`[invoiceDownload] Customer attempted to download invoice for different client`);
              throw new Error403(req.language);
            }
          } catch (err) {
            if (err instanceof Error403) throw err;
            console.error('[invoiceDownload] Error validating customer access:', err);
            throw new Error403(req.language);
          }
        }
      }
    }

    const result = await service.exportToFile(id, format);

    if (format === 'pdf') {
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename=invoice-${id}.pdf`);
    }

    return res.send(result.buffer);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
