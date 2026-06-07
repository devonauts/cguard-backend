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
// The tenant-assignable built-in roles. Two keys from Roles.values are
// intentionally excluded:
//   - 'superadmin' is a GLOBAL platform role (the user.isSuperadmin flag),
//     never a per-tenant role, so seeding it per tenant is meaningless.
//   - 'custom' is a PLACEHOLDER for user-defined roles, not a concrete role;
//     a real custom role is created on demand with its own slug/permissions.
// Seeding these produced noisy "Validation error" upsert warnings on boot.
const NON_TENANT_ROLES = new Set(['superadmin', 'custom']);

function seedableRoleKeys(): string[] {
  return Object.keys(Roles.values || {}).filter((k) => !NON_TENANT_ROLES.has(k));
}

/**
 * Seed the tenant-assignable built-in roles for ONE tenant. Idempotent and
 * race-safe (findOrCreate on the unique (slug, tenantId) index; a worker that
 * loses the insert race gets a unique violation, treated as benign). Pass
 * options.transaction to seed atomically as part of a larger transaction
 * (e.g. tenant creation at signup).
 */
export async function ensureBuiltInRolesForTenant(
  db: any,
  tenantId: string,
  options: { transaction?: any } = {},
): Promise<void> {
  if (!db || !db.role || !tenantId) return;
  const builtInKeys = seedableRoleKeys();
  if (!builtInKeys.length) return;
  const descriptions = (Roles as any).descriptions || {};
  const txn = options.transaction ? { transaction: options.transaction } : {};

  for (const key of builtInKeys) {
    try {
      await db.role.findOrCreate({
        where: { slug: key, tenantId },
        defaults: {
          name: key,
          slug: key,
          description: descriptions[key] || null,
          permissions: [],
          tenantId,
        },
        ...txn,
      });
    } catch (e) {
      // A unique-constraint violation just means it already exists — benign.
      if ((e as any)?.name === 'SequelizeUniqueConstraintError') continue;
      console.warn(
        '[roleSync] ensureBuiltInRolesForTenant: failed to upsert role',
        { tenantId, slug: key, error: (e as any)?.message || e },
      );
    }
  }
}

/**
 * Seed built-in roles for EVERY existing tenant (run once at startup).
 */
export async function ensureBuiltInRoles(db: any): Promise<void> {
  if (!db || !db.role || !db.tenant) return;
  const tenants = await db.tenant.findAll({ attributes: ['id'] });
  if (!tenants || !tenants.length) return;
  for (const tenant of tenants) {
    if (tenant && tenant.id) {
      await ensureBuiltInRolesForTenant(db, tenant.id);
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
  options: { transaction?: any } = {},
): Promise<void> {
  if (!db || !db.role || !db.tenantUserRole || !tenantUser) return;

  // CRITICAL: run inside the caller's transaction. When the caller has an open
  // transaction that just created/updated this tenantUser (locking its row),
  // running these writes on a SEPARATE connection makes the tenantUserRoles
  // INSERT wait on the caller's own uncommitted locks (FK on tenantUsers/roles)
  // — a self-deadlock that hangs for innodb_lock_wait_timeout (~50s).
  const txn = options.transaction ? { transaction: options.transaction } : {};

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

      let role = await db.role.findOne({ where, ...txn });

      // Fallback: if no tenant-scoped row, try any matching slug.
      if (!role) {
        role = await db.role.findOne({ where: { slug }, ...txn });
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
        ...txn,
      });
    } catch (e) {
      console.warn(
        '[roleSync] syncTenantUserRoleRows: failed to sync role row',
        { tenantUserId, slug, error: (e as any)?.message || e },
      );
    }
  }
}
