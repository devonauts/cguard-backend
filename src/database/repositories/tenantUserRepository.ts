import SequelizeRepository from '../../database/repositories/sequelizeRepository';
import AuditLogRepository from './auditLogRepository';
import Error400 from '../../errors/Error400';
import Roles from '../../security/roles';
import crypto from 'crypto';
import { Op } from 'sequelize';
import { IRepositoryOptions } from './IRepositoryOptions';
import ClientAccountRepository from './clientAccountRepository';
import BusinessInfoRepository from './businessInfoRepository';

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
        return;
      }
    } catch (e) {
      // non-fatal: continue to create if lookup fails
      console.warn('tenantUserRepository.create: existing lookup failed', (e && (e as any).message) || e);
    }

    await options.database.tenantUser.create(
      {
        tenantId,
        userId: user.id,
        status,
        roles,
      },
      { transaction },
    );

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

    console.debug('tenantUserRepository.updateRoles called', { tenantId, userId: id, roles, clientIds, postSiteIds });

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
      // Decide initial status based on whether the user already verified their email.
      const initialStatus = user && user.emailVerified
        ? selectStatus('active', roles || [])
        : selectStatus('invited', roles || []);

      // Only generate an invitation token if the initial status for the tenantUser is 'invited'
      const invitationToken = initialStatus === 'invited' ? crypto.randomBytes(20).toString('hex') : null;
      const invitationTokenExpiresAt = invitationToken ? new Date(Date.now() + (60 * 60 * 1000)) : null;

        tenantUser = await options.database.tenantUser.create(
          {
            tenantId: resolvedTenantId,
            userId: id,
            status: initialStatus,
            invitationToken,
            invitationTokenExpiresAt,
            roles: [],
          },
          { transaction },
        );
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

    // Map provided roles (ids/objects/slugs) to slugs before merging
    const incomingSlugs = await mapToSlugs(roles);

    if (options.addRoles) {
      newRoles = [...new Set([...existingRoles, ...incomingSlugs])];
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

    await tenantUser.save({
      transaction,
    });

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
            await options.database.sequelize.getQueryInterface().bulkInsert('tenant_user_client_accounts', rows, { transaction });
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
            await options.database.sequelize.getQueryInterface().bulkInsert('tenant_user_post_sites', rows, { transaction });
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

      // Merge roles
      existingTenantUser.roles = [
        ...new Set([
          ...(Array.isArray(existingTenantUser.roles) ? existingTenantUser.roles : []),
          ...(Array.isArray(invitationTenantUser.roles) ? invitationTenantUser.roles : []),
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
