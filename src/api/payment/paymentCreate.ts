import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import PaymentService from '../../services/paymentService';

export default async (req, res, next) => {
  try {
    // ensure tenant present
    if (!req.currentTenant) {
      const tenantIdFromParams = req.params && req.params.tenantId;
      const tenantIdFromHeader = req.headers && (req.headers['x-tenant-id'] || req.headers['X-Tenant-Id']);
      const tenantId = tenantIdFromParams || tenantIdFromHeader || null;
      if (tenantId) {
        req.currentTenant = { id: tenantId };
      }
    }

    // Use billingCreate permission as proxy for payment creation
    new PermissionChecker(req).validateHas(
      Permissions.values.billingCreate,
    );

    const payload = await new PaymentService(req).create(
      req.body.data,
    );

    await ApiResponseHandler.success(req, res, payload);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
