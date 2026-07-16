import ApiResponseHandler from './apiResponseHandler';
import PermissionChecker from '../services/user/permissionChecker';
import Permissions from '../security/permissions';
import Error400 from '../errors/Error400';

// These routes are mounted at /api/tenant-user-client-accounts (outside the
// /tenant/:tenantId tree) but still run through authMiddleware +
// tenantFromHeaderMiddleware, so req.currentTenant is set from the x-tenant-id
// header AFTER an isUserInTenant membership check. Everything below fails closed
// when that context is missing and scopes every query to the caller's tenant —
// this previously dumped/mutated every tenant's guard↔client pivot with no auth.
function requireTenant(req: any): string {
  const tenant = req.currentTenant;
  if (!req.currentUser || !tenant || !tenant.id) {
    throw new Error400(req.language, 'tenant.id.required');
  }
  return tenant.id;
}

// List assignments for the current tenant only.
export async function listTenantUserClientAccounts(req: any, res: any) {
  try {
    const tenantId = requireTenant(req);
    new PermissionChecker(req as any).validateHas(Permissions.values.clientAccountRead);
    const records = await (req as any).database.tenant_user_client_accounts.findAll({
      where: { tenantId },
    });
    await ApiResponseHandler.success(req, res, records);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
}

// Create an assignment — both ids must belong to the caller's tenant.
export async function createTenantUserClientAccount(req: any, res: any) {
  try {
    const tenantId = requireTenant(req);
    new PermissionChecker(req as any).validateHas(Permissions.values.clientAccountEdit);
    const db = (req as any).database;
    const { tenantUserId, clientAccountId, security_guard_id } = (req as any).body || {};
    if (!tenantUserId || !clientAccountId) {
      throw new Error400(req.language, 'validation.required');
    }

    const tenantUser = await db.tenantUser.findOne({ where: { id: tenantUserId, tenantId }, attributes: ['id'] });
    const clientAccount = await db.clientAccount.findOne({ where: { id: clientAccountId, tenantId }, attributes: ['id'] });
    if (!tenantUser || !clientAccount) {
      // Never link across tenants — treat a foreign id as a bad request.
      throw new Error400(req.language, 'validation.required');
    }

    const record = await db.tenant_user_client_accounts.create({
      tenantUserId,
      clientAccountId,
      security_guard_id: security_guard_id || null,
      tenantId,
    });
    // Note: ApiResponseHandler.success always answers 200 — a res.status(201)
    // here was dead code (re-stamped) and has been removed.
    await ApiResponseHandler.success(req, res, record);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
}

// Delete an assignment — scoped to the caller's tenant.
export async function deleteTenantUserClientAccount(req: any, res: any) {
  try {
    const tenantId = requireTenant(req);
    new PermissionChecker(req as any).validateHas(Permissions.values.clientAccountEdit);
    const { id } = req.params;
    const deleted = await (req as any).database.tenant_user_client_accounts.destroy({
      where: { id, tenantId },
    });
    await ApiResponseHandler.success(req, res, { deleted });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
}
