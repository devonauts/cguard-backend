/**
 * PATCH /api/tenant/:tenantId/guard/me/profile
 *
 * Lets a guard update their own contact details (phone, address, profile photo).
 * Notifies HR/admins in the CRM (profile.updated) — an "important action" audit
 * signal.
 *
 * Body: { phone?, address?, profileImage? }
 *  - profileImage: array of stored file descriptors (from the multipart upload
 *    credentials flow), e.g. [{ new: true, name, privateUrl, sizeInBytes }];
 *    [] clears the photo.
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

    // Profile photo: the worker-app uploads the file via the multipart
    // credentials flow and sends back the stored descriptor here. Link it to the
    // securityGuard.profileImage relation (the source of the dashboard
    // `photoUrl`); for users without a securityGuard row (e.g. supervisors) fall
    // back to the user `avatars` relation, which the Profile screen also reads.
    // Pass [] to clear. Best-effort — a link failure never 500s the whole PATCH.
    if (body.profileImage !== undefined) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const FileRepository = require('../../database/repositories/fileRepository').default;
        const fileOptions = { database: db, currentUser, currentTenant: { id: tenantId } } as any;
        const sg = await db.securityGuard.findOne({
          where: { guardId: currentUser.id, tenantId, deletedAt: null },
        });
        if (sg) {
          await FileRepository.replaceRelationFiles(
            { belongsTo: db.securityGuard.getTableName(), belongsToColumn: 'profileImage', belongsToId: sg.id },
            body.profileImage,
            fileOptions,
          );
        } else {
          await FileRepository.replaceRelationFiles(
            { belongsTo: 'user', belongsToColumn: 'avatars', belongsToId: currentUser.id },
            body.profileImage,
            fileOptions,
          );
        }
        changes.push('foto de perfil');
      } catch (e) {
        console.warn('[guardMeProfileUpdate] set profile image failed:', (e as any)?.message || e);
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
