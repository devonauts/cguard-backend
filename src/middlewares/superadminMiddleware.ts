import { Request, Response, NextFunction } from 'express';
import Error403 from '../errors/Error403';
import Error401 from '../errors/Error401';
import ApiResponseHandler from '../api/apiResponseHandler';

/**
 * Returns true when the authenticated user is a platform-level superadmin.
 *
 * Two independent signals make a user a superadmin (either is sufficient),
 * mirroring how the sign-in flow and paywall middleware decide:
 *   1. The `isSuperadmin` column on the user record (set via seed/DB), which
 *      `AuthService.findByToken` surfaces on `req.currentUser`.
 *   2. A `superadmin` / `super_admin` role on ANY of the user's tenant memberships
 *      (covers role-based superadmins promoted at sign-in but loaded flag-less here).
 */
export function isSuperadminUser(user: any): boolean {
  if (!user) return false;
  if (user.isSuperadmin === true) return true;

  // Top-level roles array (present when sign-in promoted a role-based superadmin).
  const topRoles: any[] = Array.isArray(user.roles) ? user.roles : [];
  // Per-tenant membership roles.
  const tenantRoles: any[] = Array.isArray(user.tenants)
    ? user.tenants.flatMap((t: any) => (Array.isArray(t?.roles) ? t.roles : []))
    : [];

  return [...topRoles, ...tenantRoles]
    .map((r: any) => String(r).toLowerCase())
    .some((r: string) => r === 'superadmin' || r === 'super_admin');
}

/**
 * Express guard for every `/api/superadmin/*` route.
 *
 * Runs AFTER the global `authMiddleware` (which sets `req.currentUser`), so we
 * only need to assert identity + superadmin status here. Non-authenticated →
 * 401, authenticated-but-not-superadmin → 403. The check is centralized so no
 * superadmin endpoint can be exposed without it.
 */
export function requireSuperadmin(req: Request, res: Response, next: NextFunction) {
  const currentUser = (req as any).currentUser;
  if (!currentUser || !currentUser.id) {
    return ApiResponseHandler.error(req, res, new Error401());
  }
  if (!isSuperadminUser(currentUser)) {
    return ApiResponseHandler.error(req, res, new Error403((req as any).language));
  }
  return next();
}

export default requireSuperadmin;
