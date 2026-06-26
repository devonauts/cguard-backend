import Roles from '../../security/roles';
import Error403 from '../../errors/Error403';

/**
 * Ownership guard for customer-reachable endpoints that take a clientAccountId
 * from the URL/body. STAFF/ADMIN callers pass through (their data access is
 * governed by tenant scoping + repo ACLs). A 'customer' caller may ONLY touch a
 * clientAccount they own — their primary `clientAccount.userId`, OR one granted
 * to them via the `tenant_user_client_accounts` multi-access pivot. Throws
 * Error403 otherwise.
 *
 * Centralizes the check several endpoints reimplemented (or omitted), and closes
 * the multi-access gap where granted extra users were wrongly denied/over-served.
 */
export default async function assertClientAccess(
  req: any,
  clientAccountId: string,
): Promise<void> {
  const currentUser = req.currentUser;
  const currentTenant = req.currentTenant;
  if (!currentUser || !currentTenant) {
    // No authenticated tenant context — fail closed.
    throw new Error403(req.language);
  }

  const tenantForUser = (currentUser.tenants || [])
    .filter((t: any) => t && t.status === 'active')
    .find((t: any) => t.tenant && t.tenant.id === currentTenant.id);
  if (!tenantForUser) {
    throw new Error403(req.language);
  }

  const roles = tenantForUser.roles || [];
  const isCustomer = Array.isArray(roles)
    ? roles.includes(Roles.values.customer)
    : String(roles) === Roles.values.customer;
  // Staff/admin are not client-scoped here.
  if (!isCustomer) return;

  if (!clientAccountId) {
    throw new Error403(req.language);
  }

  // Their own primary clientAccount.
  const own = await req.database.clientAccount.findOne({
    where: { userId: currentUser.id, tenantId: currentTenant.id },
    attributes: ['id'],
  });
  if (own && String(own.id) === String(clientAccountId)) return;

  // Or a clientAccount granted via the multi-access pivot.
  try {
    const [granted] = await req.database.sequelize.query(
      `SELECT 1 FROM tenant_user_client_accounts tuc
         JOIN tenantUsers tu ON tu.id = tuc.tenantUserId
        WHERE tuc.clientAccountId = :cid
          AND tu.userId = :uid
          AND (tu.tenantId = :tid OR tuc.tenantId = :tid)
          AND tuc.deletedAt IS NULL
        LIMIT 1`,
      { replacements: { cid: clientAccountId, uid: currentUser.id, tid: currentTenant.id } },
    );
    if (granted && granted.length) return;
  } catch (e) {
    // Pivot table/columns missing → treat as no grant (fail closed).
  }

  throw new Error403(req.language);
}
