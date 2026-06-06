import bcrypt from 'bcryptjs';
import TenantUserRepository from '../../database/repositories/tenantUserRepository';
import UserRepository from '../../database/repositories/userRepository';
import Error400 from '../../errors/Error400';

const BCRYPT_SALT_ROUNDS = 12;

const PASSWORD_POLICY_ERROR =
  'mínimo 8 caracteres y contener al menos una letra mayúscula, una letra minúscula, un número y un carácter especial.';

function isStrongPassword(password): boolean {
  if (!password || String(password).length < 8) return false;
  return (
    /[A-Z]/.test(password) &&
    /[a-z]/.test(password) &&
    /[0-9]/.test(password) &&
    /[^A-Za-z0-9]/.test(password)
  );
}

export interface AcceptInvitationInput {
  password?: string;
  language?: string;
}

export interface AcceptInvitationResult {
  userId: any;
  tenantId: any;
  status: string;
}

/**
 * Hardened invitation acceptance. The invitation `token` is the ONLY trust
 * anchor: we resolve EXACTLY the user/tenant that the token belongs to and
 * mutate only that user/tenantUser. There is intentionally NO fallback to
 * securityGuardId resolution and NO reliance on req, impersonation, or
 * bypass flags. All repository calls are scoped through a locally-built
 * options object whose currentUser/currentTenant are taken from the token's
 * own tenantUser row, so downstream repository helpers (which key off
 * options.currentUser) can only ever act on the token owner.
 */
export default class InvitationAcceptanceService {
  static async acceptInvitation(
    db: any,
    token: string,
    input: AcceptInvitationInput = {},
  ): Promise<AcceptInvitationResult> {
    const language = input && input.language;

    if (!token) {
      throw new Error400(language, 'auth.invalidInvitationToken', 'Invalid invitation token');
    }

    // Minimal lookup options. We do NOT trust any caller-provided currentUser
    // here; the token lookup itself validates token existence + expiry.
    const lookupOptions: any = {
      language,
      database: db,
      currentUser: { id: null },
      currentTenant: { id: null },
    };

    const tenantUser = await TenantUserRepository.findByInvitationToken(
      token,
      lookupOptions,
    );

    if (!tenantUser || !tenantUser.user || !tenantUser.tenant) {
      throw new Error400(language, 'auth.invalidInvitationToken', 'Invalid invitation token');
    }

    const tokenUser = tenantUser.user;
    const tokenTenant = tenantUser.tenant;

    // Scoped options: currentUser/currentTenant are pinned to the token owner.
    // Repository helpers (updatePassword, markEmailVerified, acceptInvitation)
    // derive the acting/affected user from options.currentUser, so this scoping
    // guarantees we can ONLY mutate the token's own user — never another user
    // resolved via securityGuardId or any other secondary anchor.
    const scopedOptions: any = {
      language,
      database: db,
      currentUser: tokenUser,
      currentTenant: tokenTenant,
    };

    // Set password ONLY for the token's user, when provided.
    if (input && typeof input.password !== 'undefined' && input.password !== null && input.password !== '') {
      if (!isStrongPassword(input.password)) {
        throw new Error400(language, 'auth.weakPassword', PASSWORD_POLICY_ERROR);
      }
      const hashed = await bcrypt.hash(input.password, BCRYPT_SALT_ROUNDS);
      await UserRepository.updatePassword(tokenUser.id, hashed, false, scopedOptions);
    }

    // Mark email verified for the token's user.
    await UserRepository.markEmailVerified(tokenUser.id, scopedOptions);

    // Accept the tenant invitation for the token's user only. acceptInvitation
    // re-resolves the tenantUser from the token and keys the activation off
    // options.currentUser (== tokenUser), so it cannot touch a different user.
    await TenantUserRepository.acceptInvitation(token, scopedOptions);

    // Re-read final status to return an accurate result.
    let status = 'active';
    try {
      const finalTenantUser = await TenantUserRepository.findByTenantAndUser(
        tokenTenant.id,
        tokenUser.id,
        scopedOptions,
      );
      if (finalTenantUser && finalTenantUser.status) {
        status = finalTenantUser.status;
      }
    } catch (e) {
      // non-fatal: acceptInvitation already activated the row.
    }

    return {
      userId: tokenUser.id,
      tenantId: tokenTenant.id,
      status,
    };
  }
}
