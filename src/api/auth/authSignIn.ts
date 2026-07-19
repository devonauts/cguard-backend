/** @openapi { "summary": "Sign in", "requestBody": { "content": { "application/json": { "schema": { "type": "object", "properties": { "email": { "type": "string" }, "password": { "type": "string" }, "invitationToken": { "type": "string" }, "tenantId": { "type": "string" } }, "required": ["email","password"] } } } }, "responses": { "200": { "description": "Auth payload" }, "401": { "description": "Invalid credentials" } } } */

import ApiResponseHandler from '../apiResponseHandler'
import AuthService from '../../services/auth/authService'
import { assertChannelAllowed, normalizeAppChannel } from '../../security/channelAccess'

export default async (req, res) => {
  try {
    const payload = await AuthService.signin(
      req.body.email,
      req.body.password,
      req.body.invitationToken,
      req.body.tenantId,
      req,
    )

    // Enforce channel ↔ role. The CRM sends app:'web', the guard app app:'worker',
    // the supervisor app app:'supervisor'. A securityGuard/securitySupervisor/
    // customer may NOT obtain a CRM ('web') session, and an office/admin may not
    // sign in through a field app — throws 403 + a "use the X app" message code.
    const tenantEntry = (payload?.user as any)?.tenant;
    const roles: string[] = [
      ...(Array.isArray(tenantEntry?.roles) ? tenantEntry.roles : []),
      ...(Array.isArray((payload?.user as any)?.roles) ? (payload as any).user.roles : []), // superadmin path
    ].map((r: any) => String(r));
    assertChannelAllowed(roles, normalizeAppChannel(req.body.app), req.language);

    // ✅ RETORNO OBLIGATORIO para evitar doble respuesta
    return ApiResponseHandler.success(req, res, payload)

  } catch (error: any) {
    // Audit the failed login attempt (bad credentials, unverified email, etc.).
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { logSecurityEvent, clientCtx } = require('../../services/auth/securityAudit');
      const ctx = clientCtx(req);
      await logSecurityEvent(req.database, {
        tenantId: req.body?.tenantId || null,
        email: req.body?.email || null,
        event: 'login_failed',
        outcome: 'failure',
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        detail: (error && (error.messageCode || error.message)) || 'login failed',
      });
    } catch { /* ignore */ }
    // ✅ RETORNO OBLIGATORIO para evitar doble respuesta
    return ApiResponseHandler.error(req, res, error)
  }
}
