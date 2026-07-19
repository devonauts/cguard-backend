import SequelizeRepository from '../../database/repositories/sequelizeRepository';
import AuditLogRepository from '../../database/repositories/auditLogRepository';
import lodash from 'lodash';
import SequelizeFilterUtils from '../../database/utils/sequelizeFilterUtils';
import Error404 from '../../errors/Error404';
import Error400 from '../../errors/Error400';
import Sequelize from 'sequelize';import UserRepository from './userRepository';
import FileRepository from './fileRepository';
import { batchSignFiles } from '../utils/listQuery';
import { IRepositoryOptions } from './IRepositoryOptions';

const Op = Sequelize.Op;

/**
 * Coerce any incoming date-ish value to a clean `YYYY-MM-DD` string for a
 * DATEONLY column, or null when it's blank/unparseable. The form may send an
 * empty string, a full ISO datetime, or a localized string — all of which made
 * the DATEONLY insert throw ("hiringContractDate/birthDate is bad"). This makes
 * guard create/update tolerant instead of erroring.
 */
function toDateOnlyOrNull(v: any): string | null {
  if (v == null) return null;
  if (typeof v === 'string') {
    const s = v.trim();
    if (!s) return null;
    const iso = s.match(/^(\d{4}-\d{2}-\d{2})/); // already YYYY-MM-DD[...]
    if (iso) return iso[1];
  }
  const d = v instanceof Date ? v : new Date(v);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

class SecurityGuardRepository {

  static async create(data, options: IRepositoryOptions) {
    const currentUser = SequelizeRepository.getCurrentUser(
      options,
    );

    const tenant = SequelizeRepository.getCurrentTenant(
      options,
    );

    const transaction = SequelizeRepository.getTransaction(
      options,
    );

    // If caller marked this as a draft (partial) creation flow, fill required DB fields
    // with safe placeholders to avoid NOT NULL DB errors. These must be updated later.
    let createPayload: any = lodash.pick(data, [
      'governmentId',
      'fullName',
      'hiringContractDate',
      'gender',
      'isOnDuty',
      'bloodType',
      'guardCredentials',
      'birthDate',
      'birthPlace',
      'maritalStatus',
      'academicInstruction',
      'address',          
      'importHash',
      'availability',
      'languages',
      'skills',
      'guardType',
      'workRules',
    ]);

    // Normalize date-only fields so a blank/odd-format value becomes null (or a
    // clean YYYY-MM-DD) instead of crashing the DATEONLY insert. birthDate=null
    // is then backfilled by the draft placeholder logic below.
    createPayload.hiringContractDate = toDateOnlyOrNull(createPayload.hiringContractDate);
    if (createPayload.birthDate !== undefined) {
      createPayload.birthDate = toDateOnlyOrNull(createPayload.birthDate);
    }

    createPayload.guardId = data.guard || null;
    createPayload.tenantId = tenant.id;
    createPayload.createdById = currentUser.id;
    createPayload.updatedById = currentUser.id;

    if (data && data.isDraft) {
      // Ensure guardId exists (required FK)
      if (!createPayload.guardId) {
        throw new Error('Draft securityGuard requires a valid guard id');
      }

      // Try to fetch user to build sensible defaults
      try {
        const guardUser = await options.database.user.findByPk(createPayload.guardId, { transaction });
        const userFullName = guardUser
          ? (guardUser.fullName || [guardUser.firstName, guardUser.lastName].filter(Boolean).join(' '))
          : null;

        // Prefer any name sent in the incoming payload (e.g. firstName/lastName or fullName)
        const incomingFullName = data.fullName || ((data.firstName || data.lastName)
          ? [data.firstName, data.lastName].filter(Boolean).join(' ')
          : null);

        // fullName is the denormalized identity cache and is NOT NULL, so it must
        // carry a value. The onboarding fields, however, are now NULLABLE
        // (migration z20260624): leave them NULL when not provided instead of
        // seeding placeholder values (gender 'Masculino', bloodType 'O+', etc.).
        // Those placeholders used to surface in the edit form as if they were the
        // vigilante's real data ("shows other data not related"). They are filled
        // when the tenant edits the profile or the guard completes registration.
        createPayload.fullName = createPayload.fullName || incomingFullName || userFullName || 'PENDING NAME';
        createPayload.governmentId = createPayload.governmentId || null;
        createPayload.gender = createPayload.gender || null;
        createPayload.bloodType = createPayload.bloodType || null;
        createPayload.birthDate = createPayload.birthDate || null;
        createPayload.maritalStatus = createPayload.maritalStatus || null;
        createPayload.academicInstruction = createPayload.academicInstruction || null;
      } catch (err) {
        // If something goes wrong getting the user, rethrow a clearer error
        const message =
          err instanceof Error ? err.message : String(err);
        throw new Error('Error preparing draft security guard: ' + message);
      }
    }

    // securityGuard.fullName is a DENORMALIZED CACHE synced from the linked
    // user (single source of identity) — do not edit it independently.
    // When a real user is linked (non-draft, or a draft that already has a
    // user), derive fullName FROM that user instead of trusting request data.
    // Drafts without a usable user name keep the staged fullName as a
    // placeholder and are reconciled on activation (see update()).
    try {
      if (createPayload.guardId) {
        const guardUser = await options.database.user.findByPk(
          createPayload.guardId,
          { transaction },
        );
        const userFullName = guardUser
          ? (guardUser.fullName ||
              [guardUser.firstName, guardUser.lastName].filter(Boolean).join(' '))
          : null;
        if (userFullName && String(userFullName).trim()) {
          createPayload.fullName = String(userFullName).trim();
        }
      }
    } catch (e) {
      console.warn(
        'securityGuardRepository.create: could not derive fullName from user',
        (e && (e as any).message) || e,
      );
    }

    const record = await options.database.securityGuard.create(
      createPayload,
      {
        transaction,
      },
    );

    await record.setMemos(data.memos || [], {
      transaction,
    });
    await record.setRequests(data.requests || [], {
      transaction,
    });

    await FileRepository.replaceRelationFiles(
      {
        belongsTo: options.database.securityGuard.getTableName(),
        belongsToColumn: 'profileImage',
        belongsToId: record.id,
      },
      data.profileImage,
      options,
    );
    await FileRepository.replaceRelationFiles(
      {
        belongsTo: options.database.securityGuard.getTableName(),
        belongsToColumn: 'credentialImage',
        belongsToId: record.id,
      },
      data.credentialImage,
      options,
    );
    await FileRepository.replaceRelationFiles(
      {
        belongsTo: options.database.securityGuard.getTableName(),
        belongsToColumn: 'recordPolicial',
        belongsToId: record.id,
      },
      data.recordPolicial,
      options,
    );
  
    await this._createAuditLog(
      AuditLogRepository.CREATE,
      record,
      data,
      options,
    );

    return this.findById(record.id, options);
  }

  static async update(id, data, options: IRepositoryOptions) {
    const currentUser = SequelizeRepository.getCurrentUser(
      options,
    );

    const transaction = SequelizeRepository.getTransaction(
      options,
    );


    const currentTenant = SequelizeRepository.getCurrentTenant(
      options,
    );

    let record = await options.database.securityGuard.findOne(      
      {
        where: {
          id,
          tenantId: currentTenant.id,
        },
        transaction,
      },
    );

    if (!record) {
      throw new Error404();
    }

    // Build an update payload and only include guardId when explicitly provided
    const payloadToUpdate: any = {
      ...lodash.pick(data, [
        'governmentId',
        'fullName',
        'hiringContractDate',
        'gender',
        'isOnDuty',
        'bloodType',
        'guardCredentials',
        'birthDate',
        'birthPlace',
        'maritalStatus',
        'academicInstruction',
        'address',          
        'importHash',
        'availability',
        'languages',
        'skills',
        'guardType',
        'workRules',
      ]),
      updatedById: currentUser.id,
    };

    // Normalize date-only fields when present so a blank/odd-format value can't
    // crash the DATEONLY update. hiringContractDate is nullable; birthDate is
    // required, so drop an unparseable value (leave it unchanged) rather than null it.
    if (Object.prototype.hasOwnProperty.call(payloadToUpdate, 'hiringContractDate')) {
      payloadToUpdate.hiringContractDate = toDateOnlyOrNull(payloadToUpdate.hiringContractDate);
    }
    if (Object.prototype.hasOwnProperty.call(payloadToUpdate, 'birthDate')) {
      const bd = toDateOnlyOrNull(payloadToUpdate.birthDate);
      if (bd) payloadToUpdate.birthDate = bd;
      else delete payloadToUpdate.birthDate;
    }

    // These fields are nullable but carry notEmpty/isIn validators, so an empty
    // string from the edit form (a not-yet-filled draft) would fail validation.
    // Coerce blank → null so a partially-completed profile can still be saved.
    for (const f of ['governmentId', 'gender', 'bloodType', 'maritalStatus', 'academicInstruction']) {
      if (
        Object.prototype.hasOwnProperty.call(payloadToUpdate, f) &&
        (payloadToUpdate[f] === '' ||
          (typeof payloadToUpdate[f] === 'string' && payloadToUpdate[f].trim() === ''))
      ) {
        payloadToUpdate[f] = null;
      }
    }

    if (Object.prototype.hasOwnProperty.call(data, 'guard')) {
      // Only set guardId when the caller explicitly provided `guard` in payload
      // and the provided value is not null/undefined. This avoids overwriting
      // the existing FK with null when the caller meant to leave it unchanged.
      if (data.guard !== null && typeof data.guard !== 'undefined') {
        // data.guard may be a plain ID string or a full user object — extract just the ID
        payloadToUpdate.guardId = typeof data.guard === 'object' ? (data.guard?.id ?? null) : data.guard;
      }
    }

    // Admin identity edits (name/email/phone) must reach the linked USER (the
    // single source of identity) — ignoring them silently reverted every guard
    // rename, exactly the clientAccount/BAS bug. Propagate first, then the
    // derive block below reads the fresh values. Email only when globally free.
    {
      const effectiveGuardId = payloadToUpdate.guardId || record.guardId;
      const wantsIdentityEdit =
        data && (data.fullName || data.firstName || data.lastName || typeof data.email !== 'undefined' || typeof data.phoneNumber !== 'undefined');
      if (effectiveGuardId && wantsIdentityEdit) {
        const guardUser = await options.database.user.findByPk(effectiveGuardId, { transaction });
        if (guardUser) {
          const patch: any = {};
          const reqFull = (data.fullName || [data.firstName, data.lastName].filter(Boolean).join(' ') || '').toString().trim();
          if (reqFull && reqFull !== (guardUser.fullName || '').toString().trim()) {
            patch.fullName = reqFull;
            if (data.firstName || data.lastName) {
              patch.firstName = (data.firstName || '').toString().trim() || null;
              patch.lastName = (data.lastName || '').toString().trim() || null;
            } else {
              const parts = reqFull.split(/\s+/);
              patch.firstName = parts[0] || null;
              patch.lastName = parts.slice(1).join(' ') || null;
            }
          }
          if (typeof data.email !== 'undefined' && data.email) {
            const reqEmail = data.email.toString().trim().toLowerCase();
            if (reqEmail && reqEmail !== (guardUser.email || '').toString().trim().toLowerCase()) {
              const taken = await options.database.user.findOne({
                where: { email: reqEmail, id: { [Op.ne]: guardUser.id } },
                transaction,
              });
              if (taken) {
                throw new Error400(
                  options.language,
                  'errors.validation.message',
                  'Ese correo ya pertenece a otra cuenta.',
                );
              }
              patch.email = reqEmail;
            }
          }
          if (typeof data.phoneNumber !== 'undefined') {
            const reqPhone = (data.phoneNumber || '').toString().trim();
            if (reqPhone !== (guardUser.phoneNumber || '').toString().trim()) {
              patch.phoneNumber = reqPhone || null;
            }
          }
          if (Object.keys(patch).length) {
            await guardUser.update(patch, { transaction });
            try {
              const { syncIdentityFromUser } = require('../../services/identitySync');
              await syncIdentityFromUser(options.database, guardUser.id, options);
            } catch (e) {
              console.warn('securityGuardRepository: identity fan-out failed', (e as any)?.message || e);
            }
          }
        }
      }
    }

    // securityGuard.fullName is a DENORMALIZED CACHE synced from the linked user
    // (single source of identity) — do not edit it independently. Reconcile it
    // FROM the user here (also covers draft activation when a user is linked).
    try {
      const effectiveGuardId = payloadToUpdate.guardId || record.guardId;
      if (effectiveGuardId) {
        const guardUser = await options.database.user.findByPk(
          effectiveGuardId,
          { transaction },
        );
        const userFullName = guardUser
          ? (guardUser.fullName ||
              [guardUser.firstName, guardUser.lastName].filter(Boolean).join(' '))
          : null;
        if (userFullName && String(userFullName).trim()) {
          payloadToUpdate.fullName = String(userFullName).trim();
        }
      }
    } catch (e) {
      console.warn(
        'securityGuardRepository.update: could not derive fullName from user',
        (e && (e as any).message) || e,
      );
    }

    record = await record.update(payloadToUpdate, { transaction });

    // Update relations/files if present in the payload
    await record.setMemos(data.memos || [], { transaction });
    await record.setRequests(data.requests || [], { transaction });

    await FileRepository.replaceRelationFiles(
      {
        belongsTo: options.database.securityGuard.getTableName(),
        belongsToColumn: 'profileImage',
        belongsToId: record.id,
      },
      data.profileImage,
      options,
    );

    await FileRepository.replaceRelationFiles(
      {
        belongsTo: options.database.securityGuard.getTableName(),
        belongsToColumn: 'credentialImage',
        belongsToId: record.id,
      },
      data.credentialImage,
      options,
    );

    await FileRepository.replaceRelationFiles(
      {
        belongsTo: options.database.securityGuard.getTableName(),
        belongsToColumn: 'recordPolicial',
        belongsToId: record.id,
      },
      data.recordPolicial,
      options,
    );

    await this._createAuditLog(
      AuditLogRepository.UPDATE,
      record,
      data,
      options,
    );

    return this.findById(record.id, options);
  }

  static async destroy(id, options: IRepositoryOptions) {
    const transaction = SequelizeRepository.getTransaction(
      options,
    );

    const currentTenant = SequelizeRepository.getCurrentTenant(
      options,
    );

    let record = await options.database.securityGuard.findOne(
      {
        where: {
          id,
          tenantId: currentTenant.id,
        },
        paranoid: false,
        transaction,
      },
    );

    if (!record) {
      throw new Error404();
    }

    await record.destroy({
      transaction,
      force: true,
    });

    await this._createAuditLog(
      AuditLogRepository.DELETE,
      record,
      record,
      options,
    );
  }

  static async restore(id, options: IRepositoryOptions) {
    const transaction = SequelizeRepository.getTransaction(
      options,
    );

    const currentTenant = SequelizeRepository.getCurrentTenant(
      options,
    );

    // find the record including soft-deleted ones
    let record = await options.database.securityGuard.findOne(
      {
        where: {
          id,
          tenantId: currentTenant.id,
        },
        paranoid: false,
        transaction,
      },
    );

    if (!record) {
      throw new Error404();
    }

    // restore the record (Sequelize instance method)
    await record.restore({ transaction });

    await this._createAuditLog(
      AuditLogRepository.UPDATE,
      record,
      record,
      options,
    );
  }

  static async findById(id, options: IRepositoryOptions) {
    const transaction = SequelizeRepository.getTransaction(
      options,
    );

    const include = [
      {
        model: options.database.user,
        as: 'guard',
      },
    ];

    const currentTenant = SequelizeRepository.getCurrentTenant(
      options,
    );

    let record = await options.database.securityGuard.findOne(
      {
        where: {
          id,
          tenantId: currentTenant.id,
        },
        include,
        transaction,
      },
    );

    if (!record) {
      // Fallback: if the passed id refers to the underlying user id (guardId),
      // resolve the securityGuard record by guardId instead.
      record = await options.database.securityGuard.findOne(
        {
          where: {
            guardId: id,
            tenantId: currentTenant.id,
          },
          include,
          transaction,
        },
      );
    }

    if (!record) {
      // Use custom error message for not found guard
      const language = options && options.language ? options.language : 'es';
      throw new Error404(language, 'entities.securityGuard.errors.notFound');
    }

    // If current user is not admin, ensure the found guard is linked to one of
    // the current user's assigned post sites. We do this by checking the guard's
    // tenantUser.assignedPostSites overlap with the current user's assignedPostSites.
    try {
      const currentUser = SequelizeRepository.getCurrentUser(options);
      let isAdmin = false;
      if (currentUser && currentUser.tenants) {
        const tenantUserRec = currentUser.tenants.find((t) => t.tenant.id === currentTenant.id && t.status === 'active');
        if (tenantUserRec) {
          let roles: any = [];
          if (Array.isArray(tenantUserRec.roles)) roles = tenantUserRec.roles;
          else if (typeof tenantUserRec.roles === 'string') {
            try { roles = JSON.parse(tenantUserRec.roles); } catch (e) { roles = []; }
          }
          isAdmin = roles.includes((await import('../../security/roles')).default.values.admin);
        }
      }

      // Skip the post-site scoping when the caller explicitly bypasses
      // permission checks — e.g. an invited guard completing their OWN
      // registration via the token-validated public endpoint (they have the
      // securityGuard role but no assigned post-sites yet, so this scoping
      // would otherwise 404 their own newly-created record).
      const bypassScope = !!(options && ((options as any).bypassPermissionValidation || (options as any).bypassPrivilegeCheck));
      if (!isAdmin && !bypassScope) {
        // current user's allowed posts
        const tenantUser = await options.database.tenantUser.findOne({
          where: { tenantId: currentTenant.id, userId: currentUser.id },
          include: [{ model: options.database.businessInfo, as: 'assignedPostSites', attributes: ['id'] }],
          transaction,
        });
        const allowedPostSiteIds = (tenantUser && tenantUser.assignedPostSites && tenantUser.assignedPostSites.map((c) => c.id)) || [];
        if (!allowedPostSiteIds.length) {
          const language = options && options.language ? options.language : 'es';
          throw new Error404(language);
        }

        const guardUserId = record.guardId || (record.guard && record.guard.id);
        if (!guardUserId) {
          const language = options && options.language ? options.language : 'es';
          throw new Error404(language, 'entities.securityGuard.errors.notFound');
        }

        const guardTenantUser = await options.database.tenantUser.findOne({
          where: { tenantId: currentTenant.id, userId: guardUserId },
          include: [{ model: options.database.businessInfo, as: 'assignedPostSites', attributes: ['id'] }],
          transaction,
        });

        const guardPostIds = (guardTenantUser && guardTenantUser.assignedPostSites && guardTenantUser.assignedPostSites.map((c) => c.id)) || [];
        const overlap = guardPostIds.some((p) => allowedPostSiteIds.includes(p));
        if (!overlap) {
          const language = options && options.language ? options.language : 'es';
          throw new Error404(language, 'entities.securityGuard.errors.notFound');
        }
      }
    } catch (e) {
      // If any check fails, default to previous behaviour (fail closed by throwing)
      if (e instanceof Error404) throw e;
    }

    return this._fillWithRelationsAndFiles(record, options);
  }

  // Partial update that only touches fields/relations provided in `data`.
  static async patchUpdate(id, data, options: IRepositoryOptions) {
    const currentUser = SequelizeRepository.getCurrentUser(options);
    const transaction = SequelizeRepository.getTransaction(options);
    const currentTenant = SequelizeRepository.getCurrentTenant(options);

    let record = await options.database.securityGuard.findOne({
      where: { id, tenantId: currentTenant.id },
      transaction,
    });

    if (!record) {
      throw new Error404();
    }

    const allowed = [
      'governmentId',
      'fullName',
      'hiringContractDate',
      'gender',
      'isOnDuty',
      'bloodType',
      'guardCredentials',
      'birthDate',
      'birthPlace',
      'maritalStatus',
      'academicInstruction',
      'address',
      'importHash',
      'languages',
      'skills',
      'guardType',
      'workRules',
      'availability',
    ];

    const updatePayload: any = {};
    allowed.forEach((k) => {
      if (Object.prototype.hasOwnProperty.call(data, k)) {
        updatePayload[k] = data[k];
      }
    });

    if (Object.prototype.hasOwnProperty.call(data, 'guard')) {
      const guardVal = data.guard;
      updatePayload.guardId = typeof guardVal === 'object' && guardVal !== null
        ? (guardVal.id ?? null)
        : (guardVal || null);
    }

    // Always set updatedById
    updatePayload.updatedById = currentUser.id;

    // Admin identity edits (name/email/phone) must reach the linked USER (the
    // single source of identity) — ignoring them silently reverted every guard
    // rename, exactly the clientAccount/BAS bug. Propagate first, then the
    // derive block below reads the fresh values. Email only when globally free.
    {
      const effectiveGuardId = updatePayload.guardId || record.guardId;
      const wantsIdentityEdit =
        data && (data.fullName || data.firstName || data.lastName || typeof data.email !== 'undefined' || typeof data.phoneNumber !== 'undefined');
      if (effectiveGuardId && wantsIdentityEdit) {
        const guardUser = await options.database.user.findByPk(effectiveGuardId, { transaction });
        if (guardUser) {
          const patch: any = {};
          const reqFull = (data.fullName || [data.firstName, data.lastName].filter(Boolean).join(' ') || '').toString().trim();
          if (reqFull && reqFull !== (guardUser.fullName || '').toString().trim()) {
            patch.fullName = reqFull;
            if (data.firstName || data.lastName) {
              patch.firstName = (data.firstName || '').toString().trim() || null;
              patch.lastName = (data.lastName || '').toString().trim() || null;
            } else {
              const parts = reqFull.split(/\s+/);
              patch.firstName = parts[0] || null;
              patch.lastName = parts.slice(1).join(' ') || null;
            }
          }
          if (typeof data.email !== 'undefined' && data.email) {
            const reqEmail = data.email.toString().trim().toLowerCase();
            if (reqEmail && reqEmail !== (guardUser.email || '').toString().trim().toLowerCase()) {
              const taken = await options.database.user.findOne({
                where: { email: reqEmail, id: { [Op.ne]: guardUser.id } },
                transaction,
              });
              if (taken) {
                throw new Error400(
                  options.language,
                  'errors.validation.message',
                  'Ese correo ya pertenece a otra cuenta.',
                );
              }
              patch.email = reqEmail;
            }
          }
          if (typeof data.phoneNumber !== 'undefined') {
            const reqPhone = (data.phoneNumber || '').toString().trim();
            if (reqPhone !== (guardUser.phoneNumber || '').toString().trim()) {
              patch.phoneNumber = reqPhone || null;
            }
          }
          if (Object.keys(patch).length) {
            await guardUser.update(patch, { transaction });
            try {
              const { syncIdentityFromUser } = require('../../services/identitySync');
              await syncIdentityFromUser(options.database, guardUser.id, options);
            } catch (e) {
              console.warn('securityGuardRepository: identity fan-out failed', (e as any)?.message || e);
            }
          }
        }
      }
    }

    // securityGuard.fullName is a DENORMALIZED CACHE synced from the linked user
    // (single source of identity) — do not edit it independently. Reconcile it
    // FROM the user here (also covers draft activation when a user is linked).
    try {
      const effectiveGuardId = updatePayload.guardId || record.guardId;
      if (effectiveGuardId) {
        const guardUser = await options.database.user.findByPk(
          effectiveGuardId,
          { transaction },
        );
        const userFullName = guardUser
          ? (guardUser.fullName ||
              [guardUser.firstName, guardUser.lastName].filter(Boolean).join(' '))
          : null;
        if (userFullName && String(userFullName).trim()) {
          updatePayload.fullName = String(userFullName).trim();
        }
      }
    } catch (e) {
      console.warn(
        'securityGuardRepository.patchUpdate: could not derive fullName from user',
        (e && (e as any).message) || e,
      );
    }

    // Apply only provided scalar fields
    if (Object.keys(updatePayload).length) {
      record = await record.update(updatePayload, { transaction });
    }

    // Only update associations/files if present in the payload
    if (Object.prototype.hasOwnProperty.call(data, 'memos')) {
      await record.setMemos(data.memos || [], { transaction });
    }
    if (Object.prototype.hasOwnProperty.call(data, 'requests')) {
      await record.setRequests(data.requests || [], { transaction });
    }

    if (Object.prototype.hasOwnProperty.call(data, 'profileImage')) {
      await FileRepository.replaceRelationFiles(
        {
          belongsTo: options.database.securityGuard.getTableName(),
          belongsToColumn: 'profileImage',
          belongsToId: record.id,
        },
        data.profileImage,
        options,
      );
    }
    if (Object.prototype.hasOwnProperty.call(data, 'credentialImage')) {
      await FileRepository.replaceRelationFiles(
        {
          belongsTo: options.database.securityGuard.getTableName(),
          belongsToColumn: 'credentialImage',
          belongsToId: record.id,
        },
        data.credentialImage,
        options,
      );
    }
    if (Object.prototype.hasOwnProperty.call(data, 'recordPolicial')) {
      await FileRepository.replaceRelationFiles(
        {
          belongsTo: options.database.securityGuard.getTableName(),
          belongsToColumn: 'recordPolicial',
          belongsToId: record.id,
        },
        data.recordPolicial,
        options,
      );
    }

    await this._createAuditLog(AuditLogRepository.UPDATE, record, data, options);

    return this.findById(record.id, options);
  }

  static async filterIdInTenant(
    id,
    options: IRepositoryOptions,
  ) {
    return lodash.get(
      await this.filterIdsInTenant([id], options),
      '[0]',
      null,
    );
  }

  static async filterIdsInTenant(
    ids,
    options: IRepositoryOptions,
  ) {
    if (!ids || !ids.length) {
      return [];
    }

    const currentTenant =
      SequelizeRepository.getCurrentTenant(options);

    const where = {
      id: {
        [Op.in]: ids,
      },
      tenantId: currentTenant.id,
    };

    const records = await options.database.securityGuard.findAll(
      {
        attributes: ['id'],
        where,
      },
    );

    return records.map((record) => record.id);
  }

  static async count(filter, options: IRepositoryOptions) {
    const transaction = SequelizeRepository.getTransaction(
      options,
    );

    const tenant = SequelizeRepository.getCurrentTenant(
      options,
    );

    return options.database.securityGuard.count(
      {
        where: {
          ...filter,
          tenantId: tenant.id,
        },
        transaction,
      },
    );
  }

  static async findAndCountAll(
    { filter, limit = 0, offset = 0, orderBy = '' },
    options: IRepositoryOptions,
  ) {
    const tenant = SequelizeRepository.getCurrentTenant(
      options,
    );

    let whereAnd: Array<any> = [];
    let include = [
      {
        model: options.database.user,
        as: 'guard',
      },      
    ];

    // By default Sequelize `paranoid` excludes soft-deleted rows.
    // Allow returning archived (soft-deleted) records when requested.
    let includeDeleted = false;

    whereAnd.push({
      tenantId: tenant.id,
    });

    // If current user is not admin, restrict guards to those whose tenantUser.assignedPostSites
    // overlap with the current user's assignedPostSites.
    // ONLY applies to customer/dispatcher roles — supervisors and managers see all guards.
    try {
      const currentUser = SequelizeRepository.getCurrentUser(options);
      const RolesModule = (await import('../../security/roles')).default;
      const UNRESTRICTED_ROLES = [
        RolesModule.values.admin,
        RolesModule.values.operationsManager,
        RolesModule.values.securitySupervisor,
        RolesModule.values.hrManager,
        RolesModule.values.clientAccountManager,
        RolesModule.values.dispatcher,
        RolesModule.values.administrativeSupervisor,
        RolesModule.values.administrativeAssistant,
        RolesModule.values.secretary,
      ];
      let isUnrestricted = false;
      if (currentUser && currentUser.tenants) {
        const tenantUserRec = currentUser.tenants.find((t) => t.tenant && t.tenant.id === tenant.id && t.status === 'active');
        if (tenantUserRec) {
          let roles: any = [];
          if (Array.isArray(tenantUserRec.roles)) roles = tenantUserRec.roles;
          else if (typeof tenantUserRec.roles === 'string') {
            try { roles = JSON.parse(tenantUserRec.roles); } catch (e) { roles = []; }
          }
          isUnrestricted = roles.some((r) => UNRESTRICTED_ROLES.includes(r));
        }
      }

      if (!isUnrestricted) {
        const tenantUser = await options.database.tenantUser.findOne({
          where: { tenantId: tenant.id, userId: currentUser.id },
          include: [{ model: options.database.businessInfo, as: 'assignedPostSites', attributes: ['id'] }],
          transaction: SequelizeRepository.getTransaction(options),
        });
        let allowedPostSiteIds = (tenantUser && tenantUser.assignedPostSites && tenantUser.assignedPostSites.map((c) => c.id)) || [];

        // If no assigned posts, and current user has clientAccountId, resolve posts for that client
        if (!allowedPostSiteIds.length) {
          try {
            const clientAccountId = currentUser && (currentUser as any).clientAccountId;
            if (clientAccountId) {
              const posts = await options.database.businessInfo.findAll({ where: { tenantId: tenant.id, clientAccountId }, attributes: ['id'], transaction: SequelizeRepository.getTransaction(options) });
              allowedPostSiteIds = (posts || []).map((p) => p.id).filter(Boolean);
            }
          } catch (e) {
            // ignore
          }
        }

        if (!allowedPostSiteIds.length) {
          return { rows: [], count: 0 };
        }

        // Find tenantUsers (guards) assigned to any of these posts
        const guardTenantUsers = await options.database.tenantUser.findAll({
          where: { tenantId: tenant.id },
          include: [{ model: options.database.businessInfo, as: 'assignedPostSites', where: { id: { [Op.in]: allowedPostSiteIds } }, attributes: ['id'] }],
          transaction: SequelizeRepository.getTransaction(options),
        });

        const guardUserIds = (guardTenantUsers || []).map((t) => t.userId).filter(Boolean);
        if (!guardUserIds.length) {
          return { rows: [], count: 0 };
        }

        whereAnd.push({ guardId: { [Op.in]: guardUserIds } });
      }
    } catch (e) {
      // ignore and proceed
    }

    if (filter) {
      // Client / post-site filters resolve to guardUserIds via guardAssignment
      // (the single source of truth for guard↔station). Guards have no direct
      // client/postSite column, so without this the Vigilantes "Filtros" sheet
      // silently ignored these keys.
      if (filter.clientId || filter.postSiteId || filter.stationId) {
        try {
          const { Op: SqOp } = options.database.Sequelize;
          const stationWhere: any = { tenantId: tenant.id };
          if (filter.stationId) {
            stationWhere.id = filter.stationId;
          } else if (filter.postSiteId) {
            stationWhere.postSiteId = filter.postSiteId;
          } else {
            // stations linked to the client directly OR via any of its post-sites
            const sites = await options.database.businessInfo.findAll({
              where: { tenantId: tenant.id, clientAccountId: filter.clientId },
              attributes: ['id'],
              transaction: SequelizeRepository.getTransaction(options),
            });
            const siteIds = (sites || []).map((s: any) => s.id).filter(Boolean);
            const or: any[] = [{ stationOriginId: filter.clientId }];
            if (siteIds.length) or.push({ postSiteId: { [SqOp.in]: siteIds } });
            stationWhere[SqOp.or] = or;
          }
          const stations = await options.database.station.findAll({
            where: stationWhere,
            attributes: ['id'],
            transaction: SequelizeRepository.getTransaction(options),
          });
          const stationIds = (stations || []).map((s: any) => s.id).filter(Boolean);
          const { guardUserIdsForStations } = require('../../services/assignedStationsService');
          const guardUserIds = stationIds.length
            ? await guardUserIdsForStations(options.database, tenant.id, stationIds)
            : [];
          if (!guardUserIds.length) {
            return { rows: [], count: 0 };
          }
          whereAnd.push({ guardId: { [SqOp.in]: guardUserIds } });
        } catch (e) {
          // On resolution failure, do NOT silently return everything — no match.
          return { rows: [], count: 0 };
        }
      }

      if (filter.id) {
        // Support single id or array of ids
        if (Array.isArray(filter.id)) {
          whereAnd.push({
            id: { [Op.in]: filter.id.map((i) => SequelizeFilterUtils.uuid(i)) },
          });
        } else {
          whereAnd.push({
            ['id']: SequelizeFilterUtils.uuid(filter.id),
          });
        }
      }

      if (filter.governmentId) {
        whereAnd.push(
          SequelizeFilterUtils.ilikeIncludes(
            'securityGuard',
            'governmentId',
            filter.governmentId,
          ),
        );
      }

      if (filter.fullName) {
        whereAnd.push(
          SequelizeFilterUtils.ilikeIncludes(
            'securityGuard',
            'fullName',
            filter.fullName,
          ),
        );
      }

      if (filter.guard) {
        // Support single id or array of ids
        if (Array.isArray(filter.guard)) {
          whereAnd.push({
            guardId: { [Op.in]: filter.guard.map((g) => SequelizeFilterUtils.uuid(g)) },
          });
        } else {
          whereAnd.push({
            ['guardId']: SequelizeFilterUtils.uuid(
              filter.guard,
            ),
          });
        }
      }

      // Support explicit request to include archived/deleted records
      if (
        filter.archived === true ||
        filter.archived === 'true' ||
        filter.deleted === true ||
        filter.deleted === 'true' ||
        filter.includeDeleted === true ||
        filter.includeDeleted === 'true'
      ) {
        includeDeleted = true;
      }

      // If caller asked for archived records, treat archive as either:
      // - a soft-deleted `securityGuard` row (deletedAt IS NOT NULL), or
      // - a `tenantUser` entry with status = 'archived' (archive via tenant-user pivot).
      if (
        filter.archived === true ||
        filter.archived === 'true' ||
        filter.deleted === true ||
        filter.deleted === 'true'
      ) {
        // Ensure we include soft-deleted rows in the result set
        includeDeleted = true;

        // Find tenantUser entries with status 'archived' for this tenant
        const tenantUsersArchived = await options.database.tenantUser.findAll({
          attributes: ['userId'],
          where: {
            tenantId: tenant.id,
            status: 'archived',
          },
          transaction: SequelizeRepository.getTransaction(options),
        });

        const archivedUserIds = (tenantUsersArchived || []).map((t) => t.userId).filter(Boolean);

        // If we have archived tenant users, include securityGuard records whose guardId
        // references one of those users. Also include any soft-deleted securityGuard rows.
        if (archivedUserIds.length) {
          whereAnd.push({
            [Op.or]: [
              { deletedAt: { [Op.not]: null } },
              { guardId: { [Op.in]: archivedUserIds } },
            ],
          });
        } else {
          // No tenantUsers marked archived; fall back to returning only soft-deleted rows
          whereAnd.push({ deletedAt: { [Op.not]: null } });
        }
      }

      // Server-side filter by guard status (e.g. 'active', 'invited', 'pending', 'archived')
      if (filter.status) {
        // Normalize common frontend aliases
        let statuses: string[] = [];
        if (typeof filter.status === 'string' && filter.status.includes(',')) {
          statuses = filter.status.split(',').map((s) => s.trim());
        } else if (Array.isArray(filter.status)) {
          statuses = filter.status;
        } else {
          statuses = [String(filter.status)];
        }

        // Map aliases
        statuses = statuses.map((s) => {
          if (!s) return s;
          const lower = s.toLowerCase();
          if (lower === 'pending') return 'pending';
          if (lower === 'todos' || lower === 'all' || lower === 'any') return 'ALL';
          return lower;
        });

        // Normalize common synonyms: treat 'pending' and 'invited' as equivalent
        // so frontend options that map to either will return the same results.
        if (statuses.includes('pending') && !statuses.includes('invited')) {
          statuses.push('invited');
        }
        if (statuses.includes('invited') && !statuses.includes('pending')) {
          statuses.push('pending');
        }
        // Ensure uniqueness
        statuses = Array.from(new Set(statuses));

        // If any requested 'archived', include deleted rows
        if (statuses.includes('archived')) {
          includeDeleted = true;
        }

        // If request wanted all statuses, skip filtering by tenantUser.status
        if (statuses.includes('ALL')) {
          // no-op: don't filter by tenantUser
        } else {
          // Find tenantUser entries matching the tenant and any of the statuses
          const whereTenantUser = {
            tenantId: tenant.id,
            status: { [Op.in]: statuses },
          };

          const tenantUsers = await options.database.tenantUser.findAll({
            attributes: ['userId'],
            where: whereTenantUser,
            transaction: SequelizeRepository.getTransaction(options),
          });

          const userIds = tenantUsers.map((t) => t.userId).filter(Boolean);

          // If no users match the status, return empty result set early
          if (!userIds.length) {
            return { rows: [], count: 0 };
          }

          whereAnd.push({
            guardId: {
              [Op.in]: userIds,
            },
          });
        }
      }

      if (filter.hiringContractDateRange) {
        const [start, end] = filter.hiringContractDateRange;

        if (start !== undefined && start !== null && start !== '') {
          whereAnd.push({
            hiringContractDate: {
              [Op.gte]: start,
            },
          });
        }

        if (end !== undefined && end !== null && end !== '') {
          whereAnd.push({
            hiringContractDate: {
              [Op.lte]: end,
            },
          });
        }
      }

      if (filter.gender) {
        whereAnd.push({
          gender: filter.gender,
        });
      }

      if (
        filter.isOnDuty === true ||
        filter.isOnDuty === 'true' ||
        filter.isOnDuty === false ||
        filter.isOnDuty === 'false'
      ) {
        whereAnd.push({
          isOnDuty:
            filter.isOnDuty === true ||
            filter.isOnDuty === 'true',
        });
      }

      if (filter.bloodType) {
        whereAnd.push({
          bloodType: filter.bloodType,
        });
      }

      if (filter.guardCredentials) {
        whereAnd.push(
          SequelizeFilterUtils.ilikeIncludes(
            'securityGuard',
            'guardCredentials',
            filter.guardCredentials,
          ),
        );
      }

      if (filter.birthDateRange) {
        const [start, end] = filter.birthDateRange;

        if (start !== undefined && start !== null && start !== '') {
          whereAnd.push({
            birthDate: {
              [Op.gte]: start,
            },
          });
        }

        if (end !== undefined && end !== null && end !== '') {
          whereAnd.push({
            birthDate: {
              [Op.lte]: end,
            },
          });
        }
      }

      if (filter.birthPlace) {
        whereAnd.push(
          SequelizeFilterUtils.ilikeIncludes(
            'securityGuard',
            'birthPlace',
            filter.birthPlace,
          ),
        );
      }

      if (filter.maritalStatus) {
        whereAnd.push({
          maritalStatus: filter.maritalStatus,
        });
      }

      if (filter.academicInstruction) {
        whereAnd.push({
          academicInstruction: filter.academicInstruction,
        });
      }

      if (filter.address) {
        whereAnd.push(
          SequelizeFilterUtils.ilikeIncludes(
            'securityGuard',
            'address',
            filter.address,
          ),
        );
      }

      if (filter.createdAtRange) {
        const [start, end] = filter.createdAtRange;

        if (
          start !== undefined &&
          start !== null &&
          start !== ''
        ) {
          whereAnd.push({
            ['createdAt']: {
              [Op.gte]: start,
            },
          });
        }

        if (
          end !== undefined &&
          end !== null &&
          end !== ''
        ) {
          whereAnd.push({
            ['createdAt']: {
              [Op.lte]: end,
            },
          });
        }
      }
    }

    const where = { [Op.and]: whereAnd };

    let {
      rows,
      count,
    } = await options.database.securityGuard.findAndCountAll({
      where,
      include,
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
      order: orderBy
        ? [orderBy.split('_')]
        : [['createdAt', 'DESC']],
      transaction: SequelizeRepository.getTransaction(
        options,
      ),
      // When includeDeleted is true, set paranoid:false to include soft-deleted rows
      paranoid: includeDeleted ? false : undefined,
    });

    // LEAN list path: the guards table renders name/email/phone/status/assignment
    // — NO photos, memos, requests or tutoriales. The old per-row _fill ran ~7
    // queries + 3 file-signings PER ROW (and the CRM fetches all guards), i.e.
    // ~7N queries over the whole table. _fillForList does it in 1 batched query.
    rows = await this._fillForList(rows, options);

    return { rows, count };
  }

  static async findAllAutocomplete(query, limit, options: IRepositoryOptions) {
    const tenant = SequelizeRepository.getCurrentTenant(
      options,
    );

    let whereAnd: Array<any> = [{
      tenantId: tenant.id,
    }];

    // Only return guards whose tenantUser.status is 'active'
    try {
      const activeTenantUsers = await options.database.tenantUser.findAll({
        attributes: ['userId'],
        where: { tenantId: tenant.id, status: 'active' },
        transaction: SequelizeRepository.getTransaction(options),
      });

      const activeUserIds = (activeTenantUsers || []).map((t) => t.userId).filter(Boolean);
      if (!activeUserIds.length) {
        return [];
      }

      // Filter securityGuard.guardId to only those users
      whereAnd.push({
        guardId: { [Op.in]: activeUserIds },
      });
    } catch (e) {
      // If tenantUser lookup fails, fall back to no extra filter (safe default)
      console.warn('securityGuardRepository.findAllAutocomplete: failed to filter by active tenant users', e && (e as any).message ? (e as any).message : e);
    }

    if (query) {
      whereAnd.push({
        [Op.or]: [
          { ['id']: SequelizeFilterUtils.uuid(query) },
          {
            [Op.and]: SequelizeFilterUtils.ilikeIncludes(
              'securityGuard',
              'fullName',
              query,
            ),
          },
        ],
      });
    }

    const where = { [Op.and]: whereAnd };

    const records = await options.database.securityGuard.findAll(
      {
        // Include guardId so callers can dedupe results by the underlying user id
        attributes: ['id', 'fullName', 'guardId'],
        where,
        limit: limit ? Number(limit) : undefined,
        order: [['fullName', 'ASC']],
      },
    );

    return records.map((record) => ({
      id: record.id,
      label: record.fullName,
      guardId: record.guardId,
    }));
  }

  static async _createAuditLog(
    action,
    record,
    data,
    options: IRepositoryOptions,
  ) {
    let values = {};

    if (data) {
      values = {
        ...record.get({ plain: true }),
        profileImage: data.profileImage,
        credentialImage: data.credentialImage,
        recordPolicial: data.recordPolicial,
        memosIds: data.memos,
        requestsIds: data.requests,
      };
    }

    await AuditLogRepository.log(
      {
        entityName: 'securityGuard',
        entityId: record.id,
        action,
        values,
      },
      options,
    );
  }

  static async _fillWithRelationsAndFilesForRows(
    rows,
    options: IRepositoryOptions,
  ) {
    if (!rows) {
      return rows;
    }

    return Promise.all(
      rows.map((record) =>
        this._fillWithRelationsAndFiles(record, options),
      ),
    );
  }

  /**
   * LEAN enricher for the LIST path. Builds the same `guard` shape the CRM list
   * consumes (name/email/phone/status/hasPassword/invitationTokenExpiresAt) +
   * top-level status/archived/phoneNumber, but in ONE batched tenantUser query
   * for ALL rows — no per-row tenantUser/file/memo/request/tutorial lookups, and
   * no photo signing (the list renders none). The full detail enrichment stays in
   * findById → _fillWithRelationsAndFiles.
   */
  static async _fillForList(rows, options: IRepositoryOptions) {
    if (!rows || !rows.length) return rows;
    const tenant = SequelizeRepository.getCurrentTenant(options);
    const transaction = SequelizeRepository.getTransaction(options);

    const outputs = rows.map((r) => r.get({ plain: true }));

    // ONE query for every row's tenantUser status (was 1 per row).
    const guardUserIds = Array.from(
      new Set(outputs.map((o) => (o.guard && o.guard.id) || o.guardId).filter(Boolean)),
    );
    const tenantUsers = guardUserIds.length
      ? await options.database.tenantUser.findAll({
          where: { tenantId: tenant.id, userId: guardUserIds },
          attributes: ['userId', 'status', 'invitationTokenExpiresAt'],
          transaction,
        })
      : [];
    const tuByUser = new Map(tenantUsers.map((tu) => [String(tu.userId), tu]));

    for (const output of outputs) {
      const guardUserId = (output.guard && output.guard.id) || output.guardId;
      const rawPassword = output.guard && output.guard.password ? output.guard.password : null;
      const rawLastLoginAt = output.guard && output.guard.lastLoginAt ? output.guard.lastLoginAt : null;
      const rawMiddleName = output.guard && output.guard.middleName ? output.guard.middleName : null;
      const rawHomeAddress = output.guard && output.guard.homeAddress ? output.guard.homeAddress : null;
      const tu: any = guardUserId ? tuByUser.get(String(guardUserId)) : null;

      if (output.guard) {
        output.guard = {
          ...UserRepository.cleanupForRelationships(output.guard),
          status: tu ? tu.status : null,
          hasPassword: !!rawPassword,
          lastLoginAt: rawLastLoginAt || null,
          invitationTokenExpiresAt: tu ? tu.invitationTokenExpiresAt : null,
          middleName: rawMiddleName,
          homeAddress: rawHomeAddress,
        };
      }

      output.archived = Boolean(output.deletedAt);
      output.status = output.guard && output.guard.status ? output.guard.status : null;
      if (output.archived) output.status = 'archived';
      output.phoneNumber = output.guard && output.guard.phoneNumber ? output.guard.phoneNumber : null;

      // Credential/record scans are detail-only (large ID document images, not
      // shown in a list row). The avatar (profileImage) IS rendered in the list.
      output.credentialImage = [];
      output.recordPolicial = [];
    }

    // Sign the avatar for ALL rows in ONE file query (batched), not per-row.
    await batchSignFiles(options.database, outputs, options.database.securityGuard.getTableName(), 'profileImage');

    return outputs;
  }

  static async _fillWithRelationsAndFiles(record, options: IRepositoryOptions) {
    if (!record) {
      return record;
    }

    const output = record.get({ plain: true });

    const transaction = SequelizeRepository.getTransaction(
      options,
    );


    // Buscar status en tenantUser usando userId (guardId)
    let guardUserId = null;
    if (output.guard && output.guard.id) {
      guardUserId = output.guard.id;
    } else if (output.guardId) {
      guardUserId = output.guardId;
    }
    // Extract sensitive fields from raw guard data BEFORE cleanup
    const rawPassword = output.guard && output.guard.password ? output.guard.password : null;
    const rawLastLoginAt = output.guard && output.guard.lastLoginAt ? output.guard.lastLoginAt : null;
    const rawMiddleName = output.guard && output.guard.middleName ? output.guard.middleName : null;
    const rawHomeAddress = output.guard && output.guard.homeAddress ? output.guard.homeAddress : null;
    // bloodType + identificationNumber are owned by securityGuard (this record),
    // no longer mirrored onto the user account.

    if (guardUserId && output.tenantId) {
      const tenantUser = await options.database.tenantUser.findOne({
        where: {
          tenantId: output.tenantId,
          userId: guardUserId,
        },
      });
      const guardObj = UserRepository.cleanupForRelationships(output.guard);
      output.guard = {
        ...guardObj,
        status: tenantUser ? tenantUser.status : null,
        // Access status fields (never expose raw password hash)
        hasPassword: !!rawPassword,
        lastLoginAt: rawLastLoginAt || null,
        invitationTokenExpiresAt: tenantUser ? tenantUser.invitationTokenExpiresAt : null,
        // Extended profile fields stored on user record
        middleName: rawMiddleName,
        homeAddress: rawHomeAddress,
      };
    } else {
      output.guard = {
        ...UserRepository.cleanupForRelationships(output.guard),
        hasPassword: !!rawPassword,
        lastLoginAt: rawLastLoginAt || null,
        middleName: rawMiddleName,
        homeAddress: rawHomeAddress,
      };
    }

    // Add explicit archived boolean for convenience (soft-deleted records)
    output.archived = Boolean(output.deletedAt);

    // Add top-level status for easier frontend filtering. Prefer 'archived' when soft-deleted.
    output.status = output.guard && output.guard.status ? output.guard.status : null;
    if (output.archived) {
      output.status = 'archived';
    }

    // Expose phoneNumber at top-level so frontend can choose email or phone invites
    // (phoneNumber is stored on the related `guard` user record).
    output.phoneNumber = output.guard && output.guard.phoneNumber ? output.guard.phoneNumber : null;

    output.profileImage = await FileRepository.fillDownloadUrl(
      await record.getProfileImage({
        transaction,
      }),
    );

    output.credentialImage = await FileRepository.fillDownloadUrl(
      await record.getCredentialImage({
        transaction,
      }),
    );

    output.recordPolicial = await FileRepository.fillDownloadUrl(
      await record.getRecordPolicial({
        transaction,
      }),
    );

    output.memos = await record.getMemos({
      transaction,
    });

    output.requests = await record.getRequests({
      transaction,
    });

    return output;
  }
}

export default SecurityGuardRepository;
