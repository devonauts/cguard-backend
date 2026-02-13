import SequelizeRepository from '../../database/repositories/sequelizeRepository';
import AuditLogRepository from './auditLogRepository';
import Error400 from '../../errors/Error400';
import Roles from '../../security/roles';
import crypto from 'crypto';
import { Op } from 'sequelize';
import { IRepositoryOptions } from './IRepositoryOptions';
import ClientAccountRepository from './clientAccountRepository';
import BusinessInfoRepository from './businessInfoRepository';

// Helper to retry transient lock wait timeout errors
async function retryOnLock(fn: () => Promise<any>, attempts = 5, baseDelay = 300) {
  let lastErr: any;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err: any) {
      lastErr = err;
      const code = err && (err.code || (err.parent && err.parent.code) || (err.original && err.original.code));
      if (code === 'ER_LOCK_WAIT_TIMEOUT' && i < attempts - 1) {
        const delay = baseDelay * Math.pow(2, i);
        console.warn(`retryOnLock: lock timeout, retrying attempt ${i + 1} after ${delay}ms`);
        // eslint-disable-next-line no-await-in-loop
        await new Promise((res) => setTimeout(res, delay));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

export default class TenantUserRepository {
  
  static async findByTenantAndUser(
    tenantId,
    userId,
    options: IRepositoryOptions,
  ) {
    const transaction = SequelizeRepository.getTransaction(
      options,
    );

    return await options.database.tenantUser.findOne({
      where: {
        tenantId,
        userId,
      },
      include: ['tenant', 'user'],
      transaction,
    });
  }

  static async findByInvitationToken(
    invitationToken,
    options: IRepositoryOptions,
  ) {
    const transaction = SequelizeRepository.getTransaction(
      options,
    );

    // Only return the tenantUser if the token exists and is not expired (or has no expiry)
    const now = new Date();
    return await options.database.tenantUser.findOne({
      where: {
        invitationToken,
        [Op.or]: [
          { invitationTokenExpiresAt: null },
          { invitationTokenExpiresAt: { [Op.gt]: now } },
        ],
      },
      include: ['tenant', 'user'],
      transaction,
    });
  }

  static async create(
    tenant,
    user,
    roles,
    options: IRepositoryOptions,
  ) {
    roles = roles || [];
    const transaction = SequelizeRepository.getTransaction(
      options,
    );

    // Normalize tenantId: prefer explicit `tenant.id`, fallback to options.currentTenant
    let tenantId = tenant && tenant.id ? tenant.id : null;
    if (!tenantId) {
      const currentTenant = SequelizeRepository.getCurrentTenant(options);
      if (currentTenant && currentTenant.id) {
        tenantId = currentTenant.id;
      }
    }

    if (!tenantId) {
      throw new Error400(options.language, 'tenant.id.required');
    }

    const status = selectStatus('active', roles);

    // Defensive check: if a tenant_user already exists for this user with
    // the same tenantId or with a NULL tenantId (legacy), update that row
    // instead of creating a duplicate.
    try {
      const existing = await options.database.tenantUser.findOne({
        where: {
          userId: user.id,
          [Op.or]: [ { tenantId }, { tenantId: null } ],
        },
        transaction,
      });

      if (existing) {
        // ensure tenantId is set
        if (!existing.tenantId && tenantId) {
          existing.tenantId = tenantId;
        }
        existing.status = status;
        existing.roles = roles || [];
        await existing.save({ transaction });
        await AuditLogRepository.log(
          {
            entityName: 'user',
            entityId: user.id,
            action: AuditLogRepository.UPDATE,
            values: {
              email: user.email,
              status,
              roles,
            },
          },
          options,
        );
        return existing;
      }
    } catch (e) {
      // non-fatal: continue to create if lookup fails
      console.warn('tenantUserRepository.create: existing lookup failed', (e && (e as any).message) || e);
    }

    const created = await retryOnLock(() => options.database.tenantUser.create(
      {
        tenantId,
        userId: user.id,
        status,
        roles,
      },
      { transaction },
    ));
    // Note: creation guarded by retry wrapper at call sites if needed

    await AuditLogRepository.log(
      {
        entityName: 'user',
        entityId: user.id,
        action: AuditLogRepository.CREATE,
        values: {
          email: user.email,
          status,
          roles,
        },
      },
      options,
    );
    return created;
  }

  static async destroy(
    tenantId,
    id,
    options: IRepositoryOptions,
  ) {
    const transaction = SequelizeRepository.getTransaction(
      options,
    );

    let user = await options.database.user.findByPk(id, {
      transaction,
    });

    let tenantUser = await this.findByTenantAndUser(
      tenantId,
      id,
      options,
    );

    await tenantUser.destroy({ transaction });

    await AuditLogRepository.log(
      {
        entityName: 'user',
        entityId: user.id,
        action: AuditLogRepository.DELETE,
        values: {
          email: user.email,
        },
      },
      options,
    );
  }

  /**
   * 🔵 MULTI-TENANT METHOD
   * Encuentra todos los tenants a los que pertenece un usuario.
   * Útil para verificar si un usuario ya tiene un tenant antes de crear uno nuevo.
   * Se usa en modo multi-tenant para evitar crear múltiples tenants por usuario.
   */
  static async findByUser(userId, options: IRepositoryOptions) {
    const transaction = SequelizeRepository.getTransaction(
      options,
    );

    const records = await options.database.tenantUser.findAll({
      where: {
        userId,
      },
      include: ['tenant', 'user'],
      transaction,
    });

    return records;
  }

  // Find a tenant_user by tenantId and the user's email address.
  static async findByTenantAndEmail(tenantId, email, options: IRepositoryOptions) {
    const transaction = SequelizeRepository.getTransaction(options);
    return await options.database.tenantUser.findOne({
      where: { tenantId },
      include: [{ model: options.database.user, as: 'user', where: { email } }],
      transaction,
    });
  }

  static async updateRoles(tenantId, id, roles, options, clientIds?, postSiteIds?, securityGuardId?) {
    const transaction = SequelizeRepository.getTransaction(
      options,
    );

    // Ensure tenantId is provided; fallback to options.currentTenant
    let resolvedTenantId = tenantId;
    if (!resolvedTenantId) {
      const currentTenant = SequelizeRepository.getCurrentTenant(options);
      if (currentTenant && currentTenant.id) {
        resolvedTenantId = currentTenant.id;
      }
    }

    if (!resolvedTenantId) {
      throw new Error400(options.language, 'tenant.id.required');
    }

    // Ensure roles is a proper array
    if (!Array.isArray(roles)) {
      if (typeof roles === 'string') {
        try {
          roles = JSON.parse(roles);
        } catch (e) {
          console.warn('Failed to parse roles parameter, defaulting to empty array:', roles);
          roles = [];
        }
      } else if (roles) {
        // If it's a single value, wrap it in an array
        roles = [roles];
      } else {
        roles = [];
      }
    }

    // Map incoming role identifiers (ids, objects) to slugs
    async function mapToSlugs(inputRoles) {
      const mapped: string[] = [];
      for (const r of inputRoles) {
        if (!r && r !== 0) continue;

        // If object with slug
        if (typeof r === 'object') {
          if (r.slug) {
            mapped.push(r.slug);
            continue;
          }
          if (r.id) {
            const roleRec = await options.database.role.findByPk(r.id, { transaction });
            if (roleRec) mapped.push(roleRec.slug);
            continue;
          }
          // Fallback: try name
          if (r.name) {
            // try to find by name
            const roleByName = await options.database.role.findOne({ where: { name: r.name, tenantId: resolvedTenantId }, transaction });
            if (roleByName) mapped.push(roleByName.slug);
            continue;
          }
          continue;
        }

        // If string that looks like a UUID, try find by id
        if (typeof r === 'string') {
          const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
          if (uuidRegex.test(r)) {
            const roleRec = await options.database.role.findByPk(r, { transaction });
            if (roleRec) {
              mapped.push(roleRec.slug);
              continue;
            }
          }

          // If string looks like JSON array, ignore here (already parsed earlier)

          // Otherwise assume it's already a slug
          mapped.push(r);
        }
      }

      // unique
      return [...new Set(mapped)];
    }

      // Defensive: require explicit target user id to avoid accidentally
      // updating the current user when callers omit the `id` argument.
      if (!id) {
        throw new Error400(options.language, 'user.id.required');
      }

      // Map provided roles (ids/objects/slugs) to slugs
      let incomingSlugs = await mapToSlugs(roles);

      // Defensive validation: ensure incomingSlugs correspond to actual role records
      // This prevents accidentally passing `clientIds`/`postSiteIds` (arrays) as roles
      // which could otherwise result in unintended role assignments.
      try {
        if (incomingSlugs && incomingSlugs.length) {
          const validRoles = await options.database.role.findAll({ where: { slug: incomingSlugs }, transaction });
          const validSlugs = (validRoles || []).map((r) => r.slug);
          const filtered = (incomingSlugs || []).filter((s) => validSlugs.includes(s));
          if (filtered.length !== (incomingSlugs || []).length) {
            console.warn('tenantUserRepository.updateRoles: filtering invalid incoming role identifiers', { tenantId: resolvedTenantId, userId: id, incomingSlugs, filtered });
          }
          incomingSlugs = filtered;
        }
      } catch (e) {
        console.warn('tenantUserRepository.updateRoles: failed to validate incoming roles, proceeding with original list', e && (e as any).message ? (e as any).message : e);
      }

      // Fallback: if validation removed all incoming slugs but the caller
      // explicitly passed known system role names (e.g. Roles.values.securityGuard),
      // restore them. This avoids cases where role records are tenant-scoped
      // or missing and an invite should still grant the expected role.
      try {
        if ((!incomingSlugs || incomingSlugs.length === 0) && Array.isArray(roles) && roles.length) {
          const known = Object.values(Roles.values || {});
          const restored: string[] = [];
          for (const r of roles) {
            if (!r && r !== 0) continue;
            if (typeof r === 'string') {
              const cand = r.trim();
              // Exact match against known roles
              if (known.includes(cand)) {
                restored.push(cand);
                continue;
              }
              // Case-insensitive match
              const found = known.find((k) => String(k).toLowerCase() === cand.toLowerCase());
              if (found) {
                restored.push(found);
                continue;
              }
            }
            if (typeof r === 'object') {
              if (r.slug) restored.push(r.slug);
              else if (r.id) {
                try {
                  const roleRec = await options.database.role.findByPk(r.id, { transaction });
                  if (roleRec && roleRec.slug) restored.push(roleRec.slug);
                } catch (inner) {
                  // ignore
                }
              }
            }
          }
          if (restored.length) {
            incomingSlugs = [...new Set(restored)];
            console.warn('tenantUserRepository.updateRoles: restored known roles from input after validation filtered them out', { tenantId: resolvedTenantId, userId: id, restored: incomingSlugs });
          }
        }
      } catch (e) {
        // ignore fallback errors
      }

    console.debug('tenantUserRepository.updateRoles called', { tenantId, userId: id, roles, clientIds, postSiteIds });

      try {
        const currentUser = SequelizeRepository.getCurrentUser(options);
        const currId = currentUser && currentUser.id ? currentUser.id : null;
        // Extra debug if the update targets the current user
        if (String(currId) === String(id)) {
          console.warn('tenantUserRepository.updateRoles: updating roles for currentUser id - potential accidental self-role-change', { tenantId: resolvedTenantId, userId: id, roles, currentUserId: currId });
        }
      } catch (e) {
        // ignore logging errors
      }

      // Protective guard: do not allow callers to change roles for the current
      // authenticated user unless they explicitly opted in via
      // `options.allowSelfRoleUpdate = true`. This prevents accidental role
      // changes to the inviter when invite flows call updateRoles without
      // an explicit target id or with an incorrect id.
      try {
        const currentUser = SequelizeRepository.getCurrentUser(options);
        const currId = currentUser && currentUser.id ? currentUser.id : null;
        if (currId && String(currId) === String(id) && !options.allowSelfRoleUpdate) {
          console.warn('tenantUserRepository.updateRoles: prevented self role update; use options.allowSelfRoleUpdate to override', { tenantId: resolvedTenantId, userId: id });
          // Return existing tenantUser if present, otherwise null — do not modify.
          const existingTenantUser = await options.database.tenantUser.findOne({ where: { tenantId: resolvedTenantId, userId: id }, transaction });
          return existingTenantUser;
        }
      } catch (e) {
        // ignore lookup/logging errors and continue
      }

    let user = await options.database.user.findByPk(id, {
      transaction,
    });

    let tenantUser = await this.findByTenantAndUser(
      resolvedTenantId,
      id,
      options,
    );

    let isCreation = false;

    if (!tenantUser) {
      isCreation = true;
      // Defensive: attempt to detect an existing tenant_user by email to
      // avoid creating duplicate tenant_user rows when the same email
      // was previously invited/created under a different userId.
      try {
        if (user && user.email) {
          const normalizedEmail = String(user.email).trim().toLowerCase();
          const existingByEmail = await this.findByTenantAndEmail(resolvedTenantId, normalizedEmail, options);
          if (existingByEmail) {
            // Reuse the found tenantUser and, if different userId, migrate it
            tenantUser = existingByEmail;
            // If the tenant_user points to a different user id, update to the current user id
            if (tenantUser.userId !== id) {
              tenantUser.userId = id;
              await retryOnLock(() => tenantUser.save({ transaction }));
            }
            isCreation = false;
          }
        }
      } catch (e) {
        console.warn('tenantUserRepository.updateRoles: email dedupe lookup failed', e && (e as any).message ? (e as any).message : e);
      }
      // Decide initial status based on whether the user already verified their email.
      // Use the mapped incoming slugs (if any) so that created tenant_user
      // gets the intended roles instead of an empty array.
      const initialStatus = user && user.emailVerified
        ? selectStatus('active', incomingSlugs || [])
        : selectStatus('invited', incomingSlugs || []);

      // Only generate an invitation token if the initial status for the tenantUser is 'invited'
      const invitationToken = initialStatus === 'invited' ? crypto.randomBytes(20).toString('hex') : null;
      const invitationTokenExpiresAt = invitationToken ? new Date(Date.now() + (60 * 60 * 1000)) : null;

      tenantUser = await retryOnLock(() => options.database.tenantUser.create(
        {
          tenantId: resolvedTenantId,
          userId: id,
          status: initialStatus,
          invitationToken,
          invitationTokenExpiresAt,
          roles: incomingSlugs || [],
        },
        { transaction },
      ));
    // end creation
    }

    let { roles: existingRoles } = tenantUser;

    // Ensure existingRoles is a proper array
    if (!Array.isArray(existingRoles)) {
      if (typeof existingRoles === 'string') {
        try {
          existingRoles = JSON.parse(existingRoles);
        } catch (e) {
          console.warn('Failed to parse existing roles, defaulting to empty array:', existingRoles);
          existingRoles = [];
        }
      } else {
        existingRoles = [];
      }
    }

    let newRoles = [] as Array<string>;

    // Protective rule: if the existing tenantUser already has the `admin` role,
    // never allow `securityGuard` to be added by incoming roles (defensive).
    try {
      const existingRolesLower = (tenantUser && tenantUser.roles ? (Array.isArray(tenantUser.roles) ? tenantUser.roles : (typeof tenantUser.roles === 'string' ? JSON.parse(tenantUser.roles) : [])) : []).map((r) => String(r).toLowerCase());
      if (existingRolesLower.includes('admin')) {
        const filtered = (incomingSlugs || []).filter((r) => String(r).toLowerCase() !== 'securityguard');
        if (filtered.length !== (incomingSlugs || []).length) {
          console.warn('tenantUserRepository.updateRoles: stripping securityGuard from incoming roles because existing tenantUser has admin', { tenantId: resolvedTenantId, userId: id });
          incomingSlugs = filtered;
        }
      }
    } catch (e) {
      // ignore parsing/logging errors
    }

    // Safety: prevent accidental downgrade/role-mixing where an existing admin
    // is granted the `securityGuard` role. If the existing tenantUser already
    // has `admin`, do not add `securityGuard` to their roles.

    if (options.addRoles) {
      try {
        const existingRolesLower = (existingRoles || []).map((r) => String(r).toLowerCase());
        const incomingHasSecurityGuard = incomingSlugs.includes('securityGuard') || incomingSlugs.includes('securityguard');
        const existingHasAdmin = existingRolesLower.includes('admin');
        if (incomingHasSecurityGuard && existingHasAdmin) {
          // Remove securityGuard from incomingSlugs to avoid adding it
          const filtered = incomingSlugs.filter((r) => String(r).toLowerCase() !== 'securityguard');
          console.warn('tenantUserRepository.updateRoles: prevented adding securityGuard role to existing admin', { tenantId: resolvedTenantId, userId: id });
          newRoles = [...new Set([...existingRoles, ...filtered])];
        } else {
          newRoles = [...new Set([...existingRoles, ...incomingSlugs])];
        }
      } catch (e) {
        // Fallback to default merge if any error occurs
        newRoles = [...new Set([...existingRoles, ...incomingSlugs])];
      }
    } else if (options.removeOnlyInformedRoles) {
      newRoles = existingRoles.filter(
        (existingRole) => !incomingSlugs.includes(existingRole),
      );
    } else {
      newRoles = incomingSlugs || [];
    }

    tenantUser.roles = newRoles;
    tenantUser.status = selectStatus(
      tenantUser.status,
      newRoles,
    );

    // If the tenantUser becomes or remains in 'invited' status and has no
    // invitation token, generate one so that invitation emails/SMS can be sent.
    if ((tenantUser.status === 'invited' || tenantUser.status === 'pending') && !tenantUser.invitationToken) {
      try {
        tenantUser.invitationToken = crypto.randomBytes(20).toString('hex');
        tenantUser.invitationTokenExpiresAt = new Date(Date.now() + (60 * 60 * 1000));
      } catch (e) {
        console.warn('tenantUserRepository.updateRoles: failed to generate invitation token', e && (e as any).message ? (e as any).message : e);
      }
    }

    await retryOnLock(() => tenantUser.save({ transaction }));

    // Persist assigned clients (many-to-many pivot)
    try {
      if (clientIds !== undefined) {
        let clientsArray = clientIds || [];
        if (!Array.isArray(clientsArray)) {
          try {
            clientsArray = JSON.parse(clientsArray);
          } catch (e) {
            clientsArray = [clientsArray];
          }
        }
        // Normalize to id strings
        clientsArray = clientsArray.map((c) => (c && c.id ? c.id : c)).filter(Boolean);

        // Validate IDs belong to tenant and get the valid subset
        let validClientIds = [];
        try {
          validClientIds = await ClientAccountRepository.filterIdsInTenant(clientsArray, options);
        } catch (e) {
          validClientIds = clientsArray;
        }

        // Ensure we have a Sequelize instance with association helpers
        if (!tenantUser || typeof tenantUser.getAssignedClients !== 'function') {
          tenantUser = await options.database.tenantUser.findOne({
            where: { id: tenantUser && tenantUser.id ? tenantUser.id : id, tenantId: resolvedTenantId },
            include: [{ model: options.database.clientAccount, as: 'assignedClients' }],
            transaction,
          });
        }

        // Merge with existing assigned clients instead of replacing to avoid accidental deletion
        const existingClients = typeof tenantUser.getAssignedClients === 'function'
          ? await tenantUser.getAssignedClients({ transaction })
          : (tenantUser && tenantUser.assignedClients) || [];
        const existingIds = Array.isArray(existingClients)
          ? existingClients.map((c) => c.id)
          : [];

        const merged = [...new Set([...(existingIds || []), ...(validClientIds || [])])];

        // Debug info: show tenantUser and arrays involved in the pivot operation
        console.debug('tenantUser assignment debug - clients', {
          tenantUserId: tenantUser && tenantUser.id,
          incomingClientIds: clientsArray,
          validClientIds,
          existingIds,
          merged,
        });

        // Insert missing pivot rows manually with generated UUIDs to avoid relying on DB defaults
        const toInsertClientIds = (merged || []).filter((cid) => !existingIds.includes(cid));
        if (toInsertClientIds.length) {
          const now = new Date();
          const rows = toInsertClientIds.map((clientId) => ({
            id: (crypto as any).randomUUID ? (crypto as any).randomUUID() : crypto.randomBytes(16).toString('hex'),
            tenantUserId: tenantUser.id,
            clientAccountId: clientId,
            security_guard_id: securityGuardId || null,
            createdAt: now,
            updatedAt: now,
          }));

          try {
            console.debug('tenantUser assignment - inserting pivot rows (clients)', { rows });
            await retryOnLock(() => options.database.sequelize.getQueryInterface().bulkInsert('tenant_user_client_accounts', rows, { transaction }));
            console.debug('tenantUser assignment - inserted pivot rows (clients)');
          } catch (e) {
            console.error('Failed bulkInsert tenant_user_client_accounts:', e);
            throw e;
          }
        }
      }
    } catch (e) {
      // Surface the error so we can debug why the pivot insert failed
      console.error('Failed to persist tenantUser assigned clients:', e);
      throw e;
    }

    // Persist assigned post sites (businessInfo) via pivot
    try {
      if (postSiteIds !== undefined) {
        let postsArray = postSiteIds || [];
        if (!Array.isArray(postsArray)) {
          try {
            postsArray = JSON.parse(postsArray);
          } catch (e) {
            postsArray = [postsArray];
          }
        }
        postsArray = postsArray.map((p) => (p && p.id ? p.id : p)).filter(Boolean);

        // Validate IDs belong to tenant
        let validPostSiteIds = [];
        try {
          validPostSiteIds = await BusinessInfoRepository.filterIdsInTenant(postsArray, options);
        } catch (e) {
          validPostSiteIds = postsArray;
        }

        // Merge with existing assigned post sites
        // Ensure we have association helpers for post sites as well
        if (!tenantUser || typeof tenantUser.getAssignedPostSites !== 'function') {
          tenantUser = await options.database.tenantUser.findOne({
            where: { id: tenantUser && tenantUser.id ? tenantUser.id : id, tenantId: resolvedTenantId },
            include: [{ model: options.database.businessInfo, as: 'assignedPostSites' }],
            transaction,
          });
        }

        const existingPosts = typeof tenantUser.getAssignedPostSites === 'function'
          ? await tenantUser.getAssignedPostSites({ transaction })
          : (tenantUser && tenantUser.assignedPostSites) || [];
        const existingPostIds = Array.isArray(existingPosts)
          ? existingPosts.map((p) => p.id)
          : [];

        const mergedPosts = [...new Set([...(existingPostIds || []), ...(validPostSiteIds || [])])];

        // Debug info: show tenantUser and arrays involved in the pivot operation
        console.debug('tenantUser assignment debug - posts', {
          tenantUserId: tenantUser && tenantUser.id,
          incomingPostSiteIds: postsArray,
          validPostSiteIds,
          existingPostIds,
          mergedPosts,
        });

        // Insert missing pivot rows for post sites manually with generated UUIDs
        const toInsertPostIds = (mergedPosts || []).filter((pid) => !existingPostIds.includes(pid));
        if (toInsertPostIds.length) {
          const now = new Date();
          const rows = toInsertPostIds.map((postId) => ({
            id: (crypto as any).randomUUID ? (crypto as any).randomUUID() : crypto.randomBytes(16).toString('hex'),
            tenantUserId: tenantUser.id,
            businessInfoId: postId,
            security_guard_id: securityGuardId || null,
            createdAt: now,
            updatedAt: now,
          }));

          try {
            console.debug('tenantUser assignment - inserting pivot rows (posts)', { rows });
            await retryOnLock(() => options.database.sequelize.getQueryInterface().bulkInsert('tenant_user_post_sites', rows, { transaction }));
            console.debug('tenantUser assignment - inserted pivot rows (posts)');
          } catch (e) {
            console.error('Failed bulkInsert tenant_user_post_sites:', e);
            throw e;
          }
        }
      }
    } catch (e) {
      // Surface the error so we can debug why the pivot insert failed
      console.error('Failed to persist tenantUser assigned post sites:', e);
      throw e;
    }

    await AuditLogRepository.log(
      {
        entityName: 'user',
        entityId: user.id,
        action: isCreation
          ? AuditLogRepository.CREATE
          : AuditLogRepository.UPDATE,
        values: {
          email: user.email,
          status: tenantUser.status,
          roles: newRoles,
        },
      },
      options,
    );

    return tenantUser;
  }

    /**
     * Save a tenantUser instance using retry-on-lock to mitigate transient
     * ER_LOCK_WAIT_TIMEOUT errors from concurrent transactions.
     */
    static async saveTenantUser(tenantUser, options: IRepositoryOptions) {
      const transaction = SequelizeRepository.getTransaction(options);
      return await retryOnLock(() => tenantUser.save({ transaction }));
    }

  static async acceptInvitation(
    invitationToken,
    options: IRepositoryOptions,
  ) {
    const transaction = SequelizeRepository.getTransaction(
      options,
    );

    const currentUser = SequelizeRepository.getCurrentUser(
      options,
    );

    let invitationTenantUser = await this.findByInvitationToken(
      invitationToken,
      options,
    );

    const isSameEmailFromInvitation =
      invitationTenantUser.userId === currentUser.id;

    let existingTenantUser = await this.findByTenantAndUser(
      invitationTenantUser.tenantId,
      currentUser.id,
      options,
    );

    // If no exact tenant-user found, try to find any tenantUser for this user
    // that may have been created with a NULL tenantId (legacy/malformed data)
    // or other anomalies. In such cases prefer updating that record instead
    // of creating a duplicate.
    if (!existingTenantUser) {
      try {
        existingTenantUser = await options.database.tenantUser.findOne({
          where: {
            userId: currentUser.id,
            [Op.or]: [
              { tenantId: invitationTenantUser.tenantId },
              { tenantId: null },
            ],
          },
          transaction,
        });
      } catch (e) {
        // non-fatal: proceed with existing logic if this lookup fails
        const msg = (e as any) && (e as any).message ? (e as any).message : e;
        console.warn('tenantUserRepository.acceptInvitation: fallback lookup failed', msg);
      }
    }

    // There might be a case that the invite was sent to another email,
    // and the current user is also invited or is already a member
    if (
      existingTenantUser &&
      existingTenantUser.id !== invitationTenantUser.id
    ) {
      // If the existing tenantUser row corresponds to some legacy record
      // without tenantId, update it to point to the invited tenant and
      // merge roles/status. Also remove the original invitation record
      // that belonged to the invited email (if any).

      // Destroy the invitation row that is not the user's (if different user)
      try {
        await this.destroy(
          invitationTenantUser.tenantId,
          invitationTenantUser.userId,
          options,
        );
      } catch (e) {
        const msg = (e && (e as any).message) ? (e as any).message : e;
        console.warn('tenantUserRepository.acceptInvitation: failed to destroy invitationTenantUser', msg);
      }

      // Ensure tenantId is set on the existing row (fix NULL tenantId cases)
      if (!existingTenantUser.tenantId && invitationTenantUser.tenantId) {
        existingTenantUser.tenantId = invitationTenantUser.tenantId;
      }

      // Merge roles, but never add `securityGuard` to an existing admin
      const existingRolesArr = Array.isArray(existingTenantUser.roles) ? existingTenantUser.roles : [];
      const invitationRolesArr = Array.isArray(invitationTenantUser.roles) ? invitationTenantUser.roles : [];
      let filteredInvitationRoles = invitationRolesArr;
      try {
        const existingLower = existingRolesArr.map((r) => String(r).toLowerCase());
        if (existingLower.includes('admin')) {
          // Do not grant securityGuard to an existing admin
          filteredInvitationRoles = invitationRolesArr.filter((r) => String(r).toLowerCase() !== 'securityguard');
          if (filteredInvitationRoles.length !== invitationRolesArr.length) {
            console.warn('tenantUserRepository.acceptInvitation: prevented adding securityGuard role to existing admin during invitation acceptance', { tenantId: invitationTenantUser.tenantId, userId: existingTenantUser.userId });
          }
        }
      } catch (e) {
        // ignore and fallback to merging all roles
      }

      // Merge roles
      existingTenantUser.roles = [
        ...new Set([
          ...(existingRolesArr || []),
          ...(filteredInvitationRoles || []),
        ]),
      ];

      // Clear invitation fields and set active status
      existingTenantUser.invitationToken = null;
      existingTenantUser.invitationTokenExpiresAt = null;
      existingTenantUser.status = selectStatus(
        'active',
        existingTenantUser.roles,
      );

      await existingTenantUser.save({
        transaction,
      });
    } else {
      // In this case there's no tenant user for the current user and the tenant

      // Sometimes the invitation is sent not to the
      // correct email. In those cases the userId must be changed
      // to match the correct user.
      invitationTenantUser.userId = currentUser.id;
      invitationTenantUser.invitationToken = null;
      invitationTenantUser.invitationTokenExpiresAt = null;
      invitationTenantUser.status = selectStatus(
        'active',
        invitationTenantUser.roles,
      );

      await invitationTenantUser.save({
        transaction,
      });
    }

    const emailVerified =
      currentUser.emailVerified ||
      isSameEmailFromInvitation;

    await options.database.user.update(
      {
        emailVerified,
      },
      { where: { id: currentUser.id }, transaction },
    );

    const auditLogRoles = existingTenantUser
      ? existingTenantUser.roles
      : invitationTenantUser.roles;

    await AuditLogRepository.log(
      {
        entityName: 'user',
        entityId: currentUser.id,
        action: AuditLogRepository.UPDATE,
        values: {
          email: currentUser.email,
          roles: auditLogRoles,
          status: selectStatus('active', auditLogRoles),
        },
      },
      options,
    );
  }
}

function selectStatus(oldStatus, newRoles) {
  newRoles = newRoles || [];

  if (oldStatus === 'invited') {
    return oldStatus;
  }

  if (!newRoles.length) {
    return 'pending';
  }

  return 'active';
}
