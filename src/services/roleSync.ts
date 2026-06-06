import Roles from '../security/roles';

/**
 * C6 — Role join sync helpers.
 *
 * The `tenantUserRoles` join table is the FUTURE SOURCE OF TRUTH for a
 * tenantUser's roles. For now, authorization still reads the serialized
 * `tenantUser.roles` string-array (see permissionChecker.ts). These helpers
 * keep the FK-backed join populated from that string-array so it is ready to
 * become authoritative later without breaking current auth.
 *
 * All helpers are additive and best-effort; callers wrap them in try/catch.
 */

/**
 * Upserts one `roles` row per built-in role key (slug = key, name = key,
 * permissions = []) for every existing tenant. Idempotent: existing rows are
 * left untouched. Roles are tenant-scoped (role.tenantId FK), so built-in
 * roles must exist per-tenant for the join + slug lookups to resolve.
 */
export async function ensureBuiltInRoles(db: any): Promise<void> {
  if (!db || !db.role || !db.tenant) return;

  const builtInKeys = Object.keys(Roles.values || {});
  if (!builtInKeys.length) return;

  const tenants = await db.tenant.findAll({ attributes: ['id'] });
  if (!tenants || !tenants.length) return;

  const descriptions = (Roles as any).descriptions || {};

  for (const tenant of tenants) {
    const tenantId = tenant && tenant.id;
    if (!tenantId) continue;

    for (const key of builtInKeys) {
      try {
        // Look up by (slug, tenantId) — matches the unique index on roles.
        const existing = await db.role.findOne({
          where: { slug: key, tenantId },
        });
        if (existing) continue;

        await db.role.create({
          name: key,
          slug: key,
          description: descriptions[key] || null,
          permissions: [],
          tenantId,
        });
      } catch (e) {
        // Best-effort per role; never block startup.
        console.warn(
          '[roleSync] ensureBuiltInRoles: failed to upsert role',
          { tenantId, slug: key, error: (e as any)?.message || e },
        );
      }
    }
  }
}

/**
 * Ensures a `tenantUserRoles` row exists for each role slug currently held in
 * the given tenantUser's serialized `roles` string-array. Best-effort and
 * idempotent. Does NOT remove rows for roles that were dropped (transitional;
 * the string-array remains authoritative for reads).
 *
 * @param db the sequelize models object (options.database)
 * @param tenantUser a loaded tenantUser instance (must have id, tenantId, roles)
 */
export async function syncTenantUserRoleRows(
  db: any,
  tenantUser: any,
): Promise<void> {
  if (!db || !db.role || !db.tenantUserRole || !tenantUser) return;

  const tenantUserId = tenantUser.id;
  const tenantId = tenantUser.tenantId;
  if (!tenantUserId) return;

  // Normalize the serialized roles into a slug array.
  let slugs: string[] = [];
  const raw = tenantUser.roles;
  if (Array.isArray(raw)) {
    slugs = raw;
  } else if (typeof raw === 'string') {
    try {
      slugs = JSON.parse(raw);
    } catch (e) {
      slugs = [];
    }
  }
  slugs = [...new Set((slugs || []).filter((s) => !!s))];
  if (!slugs.length) return;

  for (const slug of slugs) {
    try {
      // Resolve the role row for this slug within the tenant.
      const where: any = { slug };
      if (tenantId) where.tenantId = tenantId;

      let role = await db.role.findOne({ where });

      // Fallback: if no tenant-scoped row, try any matching slug.
      if (!role) {
        role = await db.role.findOne({ where: { slug } });
      }
      if (!role) {
        // No backing role row (built-in seeding may not have run yet for a
        // brand-new tenant). Skip — this is best-effort and transitional.
        continue;
      }

      await db.tenantUserRole.findOrCreate({
        where: { tenantUserId, roleId: role.id },
        defaults: {
          tenantUserId,
          roleId: role.id,
          tenantId: tenantId || null,
        },
      });
    } catch (e) {
      console.warn(
        '[roleSync] syncTenantUserRoleRows: failed to sync role row',
        { tenantUserId, slug, error: (e as any)?.message || e },
      );
    }
  }
}
