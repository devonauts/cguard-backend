import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import CertificationService from '../../services/certificationService';

export default async (req, res, next) => {
  try {
    new PermissionChecker(req).validateHas(
      Permissions.values.certificationRead,
    );

    const payload = await new CertificationService(
      req,
    ).findAndCountAll(req.query);

    try {
      console.log('[TENANT-DIAG certification.list]', JSON.stringify({
        userEmail: req.currentUser?.email,
        userTenants: (req.currentUser?.tenants || []).map((t: any) => t?.tenant?.id || t?.tenantId).filter(Boolean),
        paramTenantId: req.params?.tenantId,
        resolvedTenant: req.currentTenant?.id,
        rowsReturned: (payload && (payload.count ?? (payload.rows || []).length)) ?? null,
        rowTenantIds: [...new Set(((payload && payload.rows) || []).map((r: any) => r.tenantId))],
      }));
    } catch { /* diag only */ }

    await ApiResponseHandler.success(req, res, payload);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
