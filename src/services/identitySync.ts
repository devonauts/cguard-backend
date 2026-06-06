import SequelizeRepository from '../database/repositories/sequelizeRepository';

/**
 * identitySync — single-writer propagation of user identity to denormalized
 * caches.
 *
 * The `user` row is the AUTHORITATIVE source of identity
 * (fullName / firstName / lastName / email / phoneNumber). A number of other
 * tables keep a DENORMALIZED COPY of (parts of) this identity for convenience
 * and historical reasons (69+ read sites depend on these mirror columns):
 *
 *   - securityGuard.fullName   (linked via securityGuard.guardId -> user.id)
 *   - clientAccount.name / lastName / email / phoneNumber
 *                              (linked via clientAccount.userId -> user.id)
 *
 * These mirror columns are a CACHE only. They are written EXCLUSIVELY from the
 * user record — never edited independently. Whenever a user's identity changes
 * we re-sync the caches here so there is exactly ONE writer (the user) and drift
 * is impossible.
 *
 * Design notes:
 *  - Best-effort: a sync failure must never break the user update. Errors are
 *    logged and swallowed.
 *  - Tenant-scoped: securityGuard rows are scoped by tenantId so we never touch
 *    another tenant's roster. clientAccount is matched on userId (which is
 *    globally unique to the user) and is left tenant-unscoped intentionally so a
 *    user that is a client across multiple tenants stays consistent everywhere.
 *  - Runs inside the caller's transaction when one is present.
 */

function buildFullName(firstName?: string | null, lastName?: string | null): string | null {
  const f = (firstName || '').toString().trim();
  const l = (lastName || '').toString().trim();
  const combined = `${f} ${l}`.trim();
  return combined || null;
}

/**
 * Re-sync all denormalized identity caches from the authoritative user record.
 *
 * @param db        Sequelize models container (options.database)
 * @param userId    The user whose identity changed
 * @param options   Repository options (used for transaction + tenant scoping)
 */
export async function syncIdentityFromUser(
  db: any,
  userId: string,
  options?: any,
): Promise<void> {
  if (!db || !userId) {
    return;
  }

  let transaction: any = undefined;
  let tenantId: string | null = null;
  try {
    transaction = options ? SequelizeRepository.getTransaction(options) : undefined;
  } catch (e) {
    transaction = undefined;
  }
  try {
    const currentTenant = options ? SequelizeRepository.getCurrentTenant(options) : null;
    tenantId = currentTenant && currentTenant.id ? currentTenant.id : null;
  } catch (e) {
    tenantId = null;
  }

  try {
    const user = await db.user.findByPk(userId, { transaction });
    if (!user) {
      return;
    }

    const firstName = (user.firstName || '').toString().trim() || null;
    const lastName = (user.lastName || '').toString().trim() || null;
    const fullName =
      (user.fullName && user.fullName.toString().trim()) ||
      buildFullName(firstName, lastName) ||
      null;
    const email = (user.email || '').toString().trim() || null;
    const phoneNumber = (user.phoneNumber || '').toString().trim() || null;

    // ── securityGuard.fullName (denormalized cache, synced from user) ──────────
    // Only write a non-empty value: the column is NOT NULL, so never blank it.
    if (fullName) {
      try {
        const where: any = { guardId: userId };
        if (tenantId) {
          where.tenantId = tenantId;
        }
        await db.securityGuard.update(
          { fullName },
          { where, transaction },
        );
      } catch (e) {
        console.warn(
          'identitySync: failed to sync securityGuard.fullName for user',
          userId,
          (e && (e as any).message) || e,
        );
      }
    }

    // ── clientAccount.name/lastName/email/phoneNumber (denormalized cache) ─────
    // clientAccount.name is NOT NULL; only update it when we have a value.
    try {
      const caUpdate: any = {};
      if (firstName) caUpdate.name = firstName;
      if (lastName !== null) caUpdate.lastName = lastName;
      if (email !== null) caUpdate.email = email;
      if (phoneNumber !== null) caUpdate.phoneNumber = phoneNumber;

      if (Object.keys(caUpdate).length) {
        await db.clientAccount.update(
          caUpdate,
          { where: { userId }, transaction },
        );
      }
    } catch (e) {
      console.warn(
        'identitySync: failed to sync clientAccount identity for user',
        userId,
        (e && (e as any).message) || e,
      );
    }
  } catch (e) {
    console.warn(
      'identitySync.syncIdentityFromUser: best-effort sync failed for user',
      userId,
      (e && (e as any).message) || e,
    );
  }
}

export default { syncIdentityFromUser };
