import PermissionChecker from '../../services/user/permissionChecker';
import Permissions from '../../security/permissions';

/**
 * Memo isolation: a memo is visible only to its RECIPIENT (the guard it's
 * addressed to) and the CRM (management/office staff). The CRM memo endpoints
 * are gated by `memosRead` = ALL_STAFF_ROLES, which historically includes the
 * guard role — so a guard could read every tenant memo (or target another guard
 * via filter[guardName]). This resolves the caller's recipient scope so the read
 * handlers can force it, closing that IDOR regardless of the (frozen, per-tenant)
 * RBAC snapshot.
 *
 * Returns:
 *   null           → caller is CRM (management or non-guard office staff) → full access.
 *   <securityGuardId> → caller is a guard → restrict to memos addressed to them.
 */
export async function memoRecipientScope(req: any): Promise<string | null> {
  // Management (can create/edit memos) always sees everything — this is "the CRM".
  // memosCreate is SUPERVISOR_ROLES only, so a guard never passes this, even under
  // an old frozen role snapshot.
  if (new PermissionChecker(req).has(Permissions.values.memosCreate)) return null;

  const db = req.database;
  const userId = req.currentUser?.id;
  const tenantId = req.currentTenant?.id;
  if (!userId || !tenantId) return null;

  // If the caller is a guard (has a securityGuard row), pin them to their own id.
  const sg = await db.securityGuard.findOne({
    where: { guardId: userId, tenantId, deletedAt: null },
    attributes: ['id'],
  });
  return sg ? String(sg.id) : null;
}
