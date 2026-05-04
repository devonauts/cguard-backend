/** @openapi { "summary": "Sign in", "requestBody": { "content": { "application/json": { "schema": { "type": "object", "properties": { "email": { "type": "string" }, "password": { "type": "string" }, "invitationToken": { "type": "string" }, "tenantId": { "type": "string" } }, "required": ["email","password"] } } } }, "responses": { "200": { "description": "Auth payload" }, "401": { "description": "Invalid credentials" } } } */

import ApiResponseHandler from '../apiResponseHandler'
import AuthService from '../../services/auth/authService'
import Error403 from '../../errors/Error403'

export default async (req, res) => {
  try {
    const payload = await AuthService.signin(
      req.body.email,
      req.body.password,
      req.body.invitationToken,
      req.body.tenantId,
      req,
    )

    // Block customer-only accounts from accessing the CRM panel.
    // They must use /auth/sign-in-customer (the mobile/portal app endpoint).
    const tenantEntry = (payload?.user as any)?.tenant;
    if (tenantEntry) {
      const roles: string[] = Array.isArray(tenantEntry.roles)
        ? tenantEntry.roles.map((r: any) => String(r).toLowerCase())
        : [];
      if (roles.length > 0 && roles.every((r) => r === 'customer')) {
        throw new Error403(req.language, 'auth.customerCrmNotAllowed');
      }
    }

    // ✅ RETORNO OBLIGATORIO para evitar doble respuesta
    return ApiResponseHandler.success(req, res, payload)

  } catch (error) {
    // ✅ RETORNO OBLIGATORIO para evitar doble respuesta
    return ApiResponseHandler.error(req, res, error)
  }
}
