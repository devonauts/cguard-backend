/**
 * PATCH /api/tenant/:tenantId/guard/me/profile
 *
 * Lets a guard update their own contact details (phone, address). Notifies HR/
 * admins in the CRM (profile.updated) — an "important action" audit signal.
 *
 * Body: { phone?, address? }
 */
import ApiResponseHandler from '../apiResponseHandler';
import Error401 from '../../errors/Error401';
import { dispatch } from '../../lib/notificationDispatcher';

export default async (req: any, res: any) => {
  try {
    const currentUser = req.currentUser;
    if (!currentUser) throw new Error401();
    const db = req.database;
    const tenantId = req.params.tenantId || (req.currentTenant && req.currentTenant.id);
    const body = req.body.data || req.body || {};

    const changes: string[] = [];

    // Phone lives on the user account.
    if (typeof body.phone === 'string' && body.phone.trim() !== (currentUser.phoneNumber || '')) {
      await db.user.update(
        { phoneNumber: body.phone.trim() },
        { where: { id: currentUser.id } },
      );
      changes.push('teléfono');
    }

    // Address lives on the securityGuard record.
    if (typeof body.address === 'string') {
      const sg = await db.securityGuard.findOne({
        where: { guardId: currentUser.id, tenantId, deletedAt: null },
      });
      if (sg && body.address.trim() !== (sg.address || '')) {
        await sg.update({ address: body.address.trim() });
        changes.push('dirección');
      }
    }

    if (changes.length) {
      try {
        await dispatch(
          'profile.updated',
          {
            guardName: currentUser.fullName || currentUser.email || 'Guardia',
            changed: changes.join(', '),
          },
          {
            database: db,
            tenantId,
            sourceEntityType: 'user',
            sourceEntityId: currentUser.id,
          },
        );
      } catch (e) {
        console.warn('[guardMeProfileUpdate] dispatch failed:', (e as any)?.message || e);
      }
    }

    return ApiResponseHandler.success(req, res, { ok: true, changed: changes });
  } catch (error) {
    return ApiResponseHandler.error(req, res, error);
  }
};
