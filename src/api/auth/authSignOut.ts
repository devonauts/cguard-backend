/** @openapi { "summary": "Sign out", "description": "Invalidates the current user's tokens (ends the active session).", "responses": { "200": { "description": "Signed out" } } } */
import ApiResponseHandler from '../apiResponseHandler';
import Error401 from '../../errors/Error401';

export default async (req, res) => {
  try {
    const currentUser = req.currentUser;
    if (!currentUser) throw new Error401();
    const db = req.database;

    // Invalidate every token issued before now → ends the active session.
    await db.user.update(
      { jwtTokenInvalidBefore: new Date() },
      { where: { id: currentUser.id } },
    );

    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { logSecurityEvent, clientCtx } = require('../../services/auth/securityAudit');
      const ctx = clientCtx(req);
      await logSecurityEvent(db, {
        tenantId: (req.currentTenant && req.currentTenant.id) || null,
        userId: currentUser.id,
        email: currentUser.email,
        event: 'logout',
        outcome: 'success',
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
    } catch { /* ignore */ }

    return ApiResponseHandler.success(req, res, { ok: true });
  } catch (error) {
    return ApiResponseHandler.error(req, res, error);
  }
};
