/** @openapi { "summary": "Admin-triggered password reset for a security guard",
 * "description": "Generates a reset token for the guard's user, emails the reset
 * link, sends an FCM push, and returns the link (admin-only fallback). Unlike the
 * self-service flow it always sends, even for invited guards.",
 * "responses": { "200": { "description": "Reset link issued" } } } */

import ApiResponseHandler from '../apiResponseHandler';
import Error400 from '../../errors/Error400';
import PermissionChecker from '../../services/user/permissionChecker';
import Permissions from '../../security/permissions';
import UserRepository from '../../database/repositories/userRepository';
import TenantRepository from '../../database/repositories/tenantRepository';
import EmailSender from '../../services/emailSender';
import { tenantSubdomain } from '../../services/tenantSubdomain';

export default async (req, res) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.securityGuardEdit);

    const db = req.database;
    const tenant = req.currentTenant;
    const sgId = req.params.id;

    // Resolve the guard's linked user account + email.
    const sg = await db.securityGuard.findOne({
      where: { id: sgId, tenantId: tenant.id },
      include: [{ model: db.user, as: 'guard' }],
    });
    if (!sg) {
      throw new Error400(req.language, 'Guardia no encontrado.');
    }
    const user = (sg as any).guard;
    const email = (user && user.email) || (sg as any).email;
    const userId = user && user.id;
    if (!email) {
      throw new Error400(req.language, 'El guardia no tiene un correo registrado. Edita su perfil y agrega un correo para poder restablecer su contraseña.');
    }

    const lower = String(email).toLowerCase();

    // Generate a fresh reset token (24h) on the user record.
    const token = await UserRepository.generatePasswordResetToken(lower, req);

    const tenantRec = await TenantRepository.findById(tenant.id, req);
    // Smart link: /guard-reset is served by nginx and tries to open the worker
    // app via the cguardpro:// deep link, falling back to the web reset page when
    // the app isn't installed. So the same link works in-app and in a browser.
    const link = `${tenantSubdomain.frontendUrl(tenantRec)}/guard-reset?token=${token}`;

    // Email (best-effort — won't block the link being returned).
    let emailed = false;
    try {
      if (EmailSender.isConfigured) {
        await new EmailSender(EmailSender.TEMPLATES.PASSWORD_RESET, { link, passwordReset: true }).sendTo(lower);
        emailed = true;
      }
    } catch (e: any) {
      console.warn('[guard password reset] email failed:', e?.message || e);
    }

    // FCM push to the guard's registered device(s) (best-effort).
    let pushed = 0;
    try {
      if (userId) {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { pushToUser } = require('../../services/pushService');
        const r = await pushToUser(db, tenant.id, userId, {
          title: 'Restablece tu contraseña',
          body: 'Un administrador solicitó restablecer tu contraseña. Revisa tu correo o toca para continuar.',
          data: { type: 'password_reset', link },
        });
        pushed = (r && r.sent) || 0;
      }
    } catch (e: any) {
      console.warn('[guard password reset] push failed:', e?.message || e);
    }

    await ApiResponseHandler.success(req, res, {
      success: true,
      email: lower,
      emailed,
      pushed,
      link,
    });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
