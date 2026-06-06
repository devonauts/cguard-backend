/**
 * Resolve a "guard" reference coming from the UI into the underlying **user id**
 * that shifts and assignments key on (`shift.guardId` / `guardAssignment.guardId`
 * are `users.id`).
 *
 * The scheduling UIs source guards from `/security-guard/autocomplete`, which can
 * yield a user id, a `securityGuard` id, or an `sg:<securityGuardId>` key. If the
 * wrong id is stored, the row is silently orphaned — the guard's worker-app
 * (`/guard/me/schedule`, filtered by `guardId = currentUser.id`) shows nothing.
 *
 * Returns:
 *   { provided:false, userId:null }            — no guard given (open shift)
 *   { provided:true,  userId:<users.id> }      — resolved to a real tenant user
 *   { provided:true,  userId:null }            — a value was given but no guard
 *                                                account matches → caller errors
 */
export async function resolveGuardUserId(
  database: any,
  tenantId: string,
  rawGuard: any,
): Promise<{ provided: boolean; userId: string | null }> {
  let id: any = rawGuard;
  if (id && typeof id === 'object') {
    id = id.id ?? id.value ?? id.guardId ?? null;
  }
  if (id == null || String(id).trim() === '') {
    return { provided: false, userId: null };
  }
  id = String(id).trim();
  // Autocomplete emits "sg:<securityGuardId>" for guards without a linked user.
  if (id.startsWith('sg:')) id = id.slice(3);

  // (1) Already a user that belongs to this tenant?
  try {
    const tu = await database.tenantUser.findOne({
      where: { tenantId, userId: id },
      attributes: ['userId'],
    });
    if (tu) return { provided: true, userId: id };
  } catch {
    /* malformed id / dialect uuid cast — fall through */
  }

  // (2) A securityGuard id → its linked user (guardId is users.id).
  try {
    const sg = await database.securityGuard.findOne({
      where: { id, tenantId, deletedAt: null },
      attributes: ['guardId'],
    });
    if (sg && sg.guardId) {
      // Confirm the linked user is in the tenant before trusting it.
      try {
        const tu = await database.tenantUser.findOne({
          where: { tenantId, userId: sg.guardId },
          attributes: ['userId'],
        });
        if (tu) return { provided: true, userId: String(sg.guardId) };
      } catch {
        /* ignore */
      }
      return { provided: true, userId: String(sg.guardId) };
    }
  } catch {
    /* malformed id — fall through */
  }

  return { provided: true, userId: null };
}
