import PermissionChecker from '../services/user/permissionChecker';

/**
 * Shadow-mode permission gate for endpoints that were historically UNGATED.
 *
 * When RBAC_ENFORCE_NEW_GATES is on, this behaves like validateHas (throws 403
 * if the user lacks the permission). When off (default), it does NOT block —
 * it only logs what WOULD have been rejected, so a release can be observed for
 * false positives before enforcement is switched on.
 */
function enforceEnabled(): boolean {
  const v = String(process.env.RBAC_ENFORCE_NEW_GATES || '').trim().toLowerCase();
  return v === 'true' || v === '1' || v === 'on';
}

export function enforceGate(req: any, permission: any): void {
  const checker = new PermissionChecker(req);
  if (enforceEnabled()) {
    checker.validateHas(permission);
    return;
  }
  try {
    if (!checker.has(permission)) {
      console.warn('[rbac-audit] would 403', {
        permission: permission && permission.id,
        user: req && req.currentUser && req.currentUser.id,
        url: req && (req.originalUrl || req.url),
        method: req && req.method,
      });
    }
  } catch (e) {
    // never let the shadow check itself break a request
    console.warn('[rbac-audit] shadow gate check failed', (e as any)?.message || e);
  }
}
