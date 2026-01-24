import PermissionChecker from '../../services/user/permissionChecker';
import Permissions from '../../security/permissions';
import ApiResponseHandler from '../apiResponseHandler';
import UserRepository from '../../database/repositories/userRepository';
import Error400 from '../../errors/Error400';
import bcrypt from 'bcryptjs';
import AuthService from '../../services/auth/authService';
import { i18n } from '../../i18n';

const BCRYPT_SALT_ROUNDS = 12;

export default async (req, res) => {
  try {
    new PermissionChecker(req).validateHas(
      Permissions.values.userEdit,
    );

    const incoming = req.body.data || req.body || {};
    const newPassword = incoming.newPassword || incoming.password;
    const oldPassword = incoming.oldPassword;

    const id = req.params.id || incoming.id;
    if (!id) {
      throw new Error400(req.language, 'user.errors.userIdRequired');
    }

    // If client provided oldPassword, this is a profile self-change flow.
    if (oldPassword) {
      // Only allow changing own password with oldPassword verification
      const currentUserId = req.currentUser && req.currentUser.id;
      if (!currentUserId || String(currentUserId) !== String(id)) {
        throw new Error400(req.language, 'user.errors.cannotUseOldPasswordForOtherUser');
      }

      if (!newPassword) {
        throw new Error400(req.language, 'user.errors.passwordRequired');
      }

      // Delegate to AuthService which verifies the old password
      await AuthService.changePassword(oldPassword, newPassword, req);
    } else {
      // Admin flow: set password for another user (or self) without old password
      if (!newPassword) {
        throw new Error400(req.language, 'user.errors.passwordRequired');
      }

      const hashed = await bcrypt.hash(newPassword, BCRYPT_SALT_ROUNDS);
      await UserRepository.updatePassword(id, hashed, true, req);
    }

    const messageCode = oldPassword
      ? 'user.passwordChanged'
      : 'user.passwordSetByAdmin';

    const lang = req && req.language ? req.language : undefined;
    const message = i18n(lang, messageCode);

    const payload = { messageCode, message };

    await ApiResponseHandler.success(req, res, payload);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
