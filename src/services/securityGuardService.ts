import Error400 from '../errors/Error400';
import SequelizeRepository from '../database/repositories/sequelizeRepository';
import { IServiceOptions } from './IServiceOptions';
import SecurityGuardRepository from '../database/repositories/securityGuardRepository';
import MemosRepository from '../database/repositories/memosRepository';
import RequestRepository from '../database/repositories/requestRepository';
import CompletionOfTutorialRepository from '../database/repositories/completionOfTutorialRepository';
import UserRepository from '../database/repositories/userRepository';
import Sequelize from 'sequelize';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import TenantUserRepository from '../database/repositories/tenantUserRepository';
import Roles from '../security/roles';

export default class SecurityGuardService {
  options: IServiceOptions;

  constructor(options) {
    this.options = options;
  }

  async create(data) {
    // Si ya existe un guardia con el mismo guardId y tenantId, actualizarlo en vez de crear uno nuevo
    if (data && data.guard) {
      try {
        const existing = await SecurityGuardRepository.findAndCountAll(
          { filter: { guard: data.guard }, limit: 1 },
          this.options,
        );
        if (existing && existing.count > 0) {
          const first = existing.rows && existing.rows[0];
          // Actualiza el guardia existente, sin importar governmentId
          return this.update(first.id, data);
        }
      } catch (err) {
        // ignore lookup errors and proceed to create a new record
      }
    }

    const transaction = await SequelizeRepository.createTransaction(
      this.options.database,
    );

    try {
      // Keep the original guard id provided by caller so we can fallback
      const originalGuardProvided = data.guard;
      const hasGuardField = Object.prototype.hasOwnProperty.call(data, 'guard');
      const originalGuard = data.guard;
      if (hasGuardField) {
        data.guard = await UserRepository.filterIdInTenant(data.guard, { ...this.options, transaction });

        // If client provided a guard id but it's not yet associated to tenant,
        // try to create the tenantUser entry within this transaction so update can proceed.
        if (!data.guard && originalGuard) {
          try {
            const currentTenant = SequelizeRepository.getCurrentTenant(this.options);
            const tenantId = currentTenant && currentTenant.id ? currentTenant.id : null;
            if (tenantId) {
              console.log('🔧 [SecurityGuardService.update] ensuring tenantUser for guard in transaction', originalGuard, 'tenant', tenantId);
              await TenantUserRepository.updateRoles(
                tenantId,
                originalGuard,
                data.roles || [],
                { ...this.options, transaction, addRoles: true },
              );
              data.guard = originalGuard;
            }
          } catch (e) {
            console.warn('⚠️ [SecurityGuardService.update] failed to ensure tenantUser in-transaction for guard', originalGuard, e && (e as any).message ? (e as any).message : e);
          }
        }
      } else {
        // Remove guard key so downstream repository.update won't treat it as provided
        delete data.guard;
      }

      // If a guard id was provided by the caller but the filter returned null
      // (user not yet associated to tenant), attempt to create the tenantUser
      // entry within the current transaction so the subsequent steps can use it.
      if (!data.guard && originalGuardProvided) {
        try {
          const currentTenant = SequelizeRepository.getCurrentTenant(this.options);
          const tenantId = currentTenant && currentTenant.id ? currentTenant.id : null;
          if (tenantId) {
            console.log('🔧 [SecurityGuardService.create] ensuring tenantUser for guard in transaction', originalGuardProvided, 'tenant', tenantId);
            await TenantUserRepository.updateRoles(
              tenantId,
              originalGuardProvided,
              data.roles || [],
              { ...this.options, transaction, addRoles: true },
            );
            // After ensuring tenantUser, set guard back to original id so create proceeds
            data.guard = originalGuardProvided;
          }
        } catch (e) {
          console.warn('⚠️ [SecurityGuardService.create] failed to ensure tenantUser in-transaction for guard', originalGuardProvided, e && (e as any).message ? (e as any).message : e);
        }
      }
      // Ensure tenantUser has `securityGuard` role when guard id is provided
      if (data.guard) {
        try {
          const currentTenant = SequelizeRepository.getCurrentTenant(this.options);
          const tenantId = currentTenant && currentTenant.id ? currentTenant.id : null;
          if (tenantId) {
            const rolesToAdd = Array.isArray(data.roles)
              ? [...new Set(data.roles)]
              : (data.roles ? [data.roles] : []);
            // Pass through client/postSite assignments when ensuring tenantUser roles
            await TenantUserRepository.updateRoles(
              tenantId,
              data.guard,
              rolesToAdd,
              { ...this.options, transaction, addRoles: true },
              // clientIds: prefer explicit array, fallback to single clientId
              data.clientIds ?? (data.clientId ? [data.clientId] : undefined),
              // postSiteIds: prefer explicit array, fallback to single postSiteId
              data.postSiteIds ?? (data.postSiteId ? [data.postSiteId] : undefined),
            );
            console.log('🔔 [SecurityGuardService.create] ensured tenantUser roles include securityGuard for user:', data.guard);
          }
        } catch (e) {
          console.warn('⚠️ [SecurityGuardService.create] failed to ensure tenantUser roles for guard:', (e && (e as any).message) ? (e as any).message : e);
        }
      }
      data.memos = await MemosRepository.filterIdsInTenant(data.memos, { ...this.options, transaction });
      data.requests = await RequestRepository.filterIdsInTenant(data.requests, { ...this.options, transaction });
      data.tutoriales = await CompletionOfTutorialRepository.filterIdsInTenant(data.tutoriales, { ...this.options, transaction });

      // If importing or creating a guard and no guard id is provided, but email is present,
      // ensure a User exists and attach it as `data.guard`. Also ensure tenantUser exists.
      if (!data.guard && data.email) {
        try {
          let user = await UserRepository.findByEmail(data.email, { ...this.options, transaction });

          if (!user) {
            const emailVerificationToken = crypto.randomBytes(20).toString('hex');
            const emailVerificationTokenExpiresAt = Date.now() + 24 * 60 * 60 * 1000;

            console.log('🔔 [SecurityGuardService.create] creating user for imported guard with email:', data.email);
            user = await UserRepository.createFromAuth({
              email: data.email,
              firstName: data.firstName || null,
              lastName: data.lastName || null,
              fullName: data.fullName || null,
              phoneNumber: data.phoneNumber || data.phone || null,
              emailVerified: false,
              emailVerificationToken,
              emailVerificationTokenExpiresAt,
              importHash: data.importHash || null,
            }, { ...this.options, transaction });

            console.log('🎫 [SecurityGuardService.create] generated emailVerificationToken for imported user:', emailVerificationToken);
          }

          // Ensure user's profile fields are stored in `users` table
          try {
            const ensureFirstLast = () => {
              const first = data.firstName || null;
              const last = data.lastName || null;
              if (!first && !last && data.fullName) {
                const parts = String(data.fullName).trim().split(/\s+/);
                if (parts.length === 1) {
                  return { firstName: parts[0], lastName: null };
                }
                const f = parts.shift();
                return { firstName: f, lastName: parts.join(' ') };
              }
              return { firstName: first, lastName: last };
            };

            const names = ensureFirstLast();
            await UserRepository.updateProfile(user.id, {
              firstName: names.firstName,
              lastName: names.lastName,
              phoneNumber: data.phoneNumber || data.phone || null,
            }, { ...this.options, transaction, bypassPermissionValidation: true });
          } catch (e) {
            console.warn('⚠️ [SecurityGuardService.create] failed to update user profile names:', (e && (e as any).message) ? (e as any).message : e);
          }
          

          const currentTenant = SequelizeRepository.getCurrentTenant(this.options);
          const tenantId = currentTenant && currentTenant.id ? currentTenant.id : null;
          if (!tenantId) {
            console.warn('⚠️ [SecurityGuardService.create] no current tenant found in options; cannot create tenantUser automatically');
          } else {
            const rolesToAdd = Array.isArray(data.roles)
              ? [...new Set(data.roles)]
              : (data.roles ? [data.roles] : []);
            // When creating tenantUser for imported guard, also persist client/postSite assignments
            await TenantUserRepository.updateRoles(
              tenantId,
              user.id,
              rolesToAdd,
              { ...this.options, transaction, addRoles: true },
              data.clientIds ?? (data.clientId ? [data.clientId] : undefined),
              data.postSiteIds ?? (data.postSiteId ? [data.postSiteId] : undefined),
            );
            console.log('🔔 [SecurityGuardService.create] tenantUser ensured/updated for imported user:', user.id, 'tenant:', tenantId);
          }

          data.guard = user.id;
        } catch (e) {
          console.warn('⚠️ [SecurityGuardService.create] import user/tenantUser creation failed:', (e && (e as any).message) ? (e as any).message : e);
        }
      }

          // If important securityGuard fields are missing, mark the record as a draft so repository fills placeholders.
          // A draft still requires a guardId, so require email or guard to be present.
          const requiredFields = ['governmentId', 'fullName', 'gender', 'bloodType', 'birthDate', 'maritalStatus', 'academicInstruction'];
          const missingRequired = requiredFields.some(f => !data[f]);
          if (missingRequired) {
            if (!data.guard) {
              throw new Error400(this.options.language, 'entities.securityGuard.import.requiresEmailOrGuard');
            }
            data.isDraft = true;
            console.log('🔔 [SecurityGuardService.create] marking imported guard as draft due to missing fields');
          }

      // Si el payload incluye password y email, crea o actualiza el usuario
      if (data.password && data.email) {
        console.log('🔔 [SecurityGuardService.create] password+email present for:', { email: data.email, guard: data.guard });
        const BCRYPT_SALT_ROUNDS = 12;
        console.log('🔍 [SecurityGuardService.create] raw password present length:', String(data.password).length);
        const hashedPassword = await bcrypt.hash(data.password, BCRYPT_SALT_ROUNDS);
        console.log('🔐 [SecurityGuardService.create] hashed password length:', String(hashedPassword).length > 0 ? String(hashedPassword).length : 0);
        // Buscar usuario por email
        let user = await UserRepository.findByEmail(data.email, { ...this.options, transaction });
        console.log('🔍 [SecurityGuardService.create] findByEmail result:', !!user, user && user.id);
          if (user) {
          // Actualizar password y phoneNumber si existe
          console.log('🔧 [SecurityGuardService.create] updating existing user password for user id', user.id);
          await UserRepository.updateProfile(user.id, {
            phoneNumber: data.phoneNumber || data.phone || null,
          }, { ...this.options, transaction });
          await UserRepository.updatePassword(user.id, hashedPassword, false, { ...this.options, transaction, bypassPermissionValidation: true });
          // Verify it was persisted
          try {
            const stored = await UserRepository.findPassword(user.id, { ...this.options, transaction });
            console.log('🔎 [SecurityGuardService.create] stored password present?', !!stored);
          } catch (checkErr) {
            console.warn('⚠️ [SecurityGuardService.create] failed to read back stored password for user id', user.id, checkErr && (checkErr as any).message ? (checkErr as any).message : checkErr);
          }
          console.log('✅ [SecurityGuardService.create] updated password for user id', user.id);
          // If this flow included an invitation token, consider the user verified
          // (they completed the invite by setting a password). Promote tenantUser
          // status via markEmailVerified which also logs the change.
          if (data._invitationToken || data.token || data.invitationToken) {
            try {
              await UserRepository.markEmailVerified(user.id, { ...this.options, transaction, bypassPermissionValidation: true });
              console.log('✅ [SecurityGuardService.create] marked email verified for user id', user.id);
            } catch (e) {
              console.warn('⚠️ [SecurityGuardService.create] failed to mark email verified for user id', user.id, e && (e as any).message ? (e as any).message : e);
            }
          }
        } else {
          // Crear usuario nuevo
          console.log('➕ [SecurityGuardService.create] creating new user with email', data.email);
          user = await UserRepository.createFromAuth({
            email: data.email,
            password: hashedPassword,
            firstName: data.firstName || null,
            lastName: data.lastName || null,
            fullName: data.fullName || null,
            phoneNumber: data.phoneNumber || data.phone || null,
            emailVerified: false,
            importHash: data.importHash || null,
          }, { ...this.options, transaction });

          try {
            const parts = data.fullName ? String(data.fullName).trim().split(/\s+/) : [];
            const first = data.firstName || (parts.length ? parts.shift() : null);
            const last = data.lastName || (parts.length ? parts.join(' ') : null);
            await UserRepository.updateProfile(user.id, {
              firstName: first,
              lastName: last,
              phoneNumber: data.phoneNumber || data.phone || null,
            }, { ...this.options, transaction, bypassPermissionValidation: true });
          } catch (e) {
            console.warn('⚠️ [SecurityGuardService.create] failed to update new user profile names:', (e && (e as any).message) ? (e as any).message : e);
          }
          // If this flow included an invitation token, mark the newly created user's
          // email as verified so they don't remain unverified after completing registration.
          if (data._invitationToken || data.token || data.invitationToken) {
            try {
              await UserRepository.markEmailVerified(user.id, { ...this.options, transaction, bypassPermissionValidation: true });
              console.log('✅ [SecurityGuardService.create] marked email verified for new user id', user.id);
            } catch (e) {
              console.warn('⚠️ [SecurityGuardService.create] failed to mark email verified for new user id', user.id, e && (e as any).message ? (e as any).message : e);
            }
          }
        }
      }

      // Hash password para guardia (si existe)
      if (data.password) {
        const BCRYPT_SALT_ROUNDS = 12;
        data.password = await bcrypt.hash(data.password, BCRYPT_SALT_ROUNDS);
      }

      // Older import-specific logic removed — user/tenantUser creation is consolidated earlier.

      const record = await SecurityGuardRepository.create(data, {
        ...this.options,
        transaction,
      });

      // Ensure user's password and verification status are persisted for all flows.
      try {
        if (data.guard && data.password) {
          // data.password at this point should be the hashed password that we stored
          // earlier for the guard record. Persist it to the users table to ensure
          // the account can sign in.
          try {
            console.log('🔐 [SecurityGuardService.create] persisting hashed password for user id', data.guard, 'hashedLength', data.password ? data.password.length : 0);
            // Log a small prefix for quick verification (do NOT log full hash in prod)
            console.log('🔐 [SecurityGuardService.create] hashed prefix:', data.password ? data.password.substring(0, 12) : null);
            await UserRepository.updatePassword(
              data.guard,
              data.password,
              false,
              { ...this.options, transaction, bypassPermissionValidation: true },
            );
            console.log('✅ [SecurityGuardService.create] updatePassword call succeeded for user id', data.guard);
            try {
              const stored = await UserRepository.findPassword(data.guard, { ...this.options, transaction });
              console.log('🔎 [SecurityGuardService.create] findPassword result present?', !!stored, 'storedPrefix:', stored ? stored.substring(0, 12) : null);
            } catch (readErr) {
              console.warn('⚠️ [SecurityGuardService.create] failed to read back stored password for user id', data.guard, readErr && (readErr as any).message ? (readErr as any).message : readErr);
            }
            console.log('✅ [SecurityGuardService.create] ensured password persisted for user id', data.guard);
          } catch (pwErr) {
            console.warn('⚠️ [SecurityGuardService.create] failed to persist password for user id', data.guard, pwErr && (pwErr as any).message ? (pwErr as any).message : pwErr);
          }
        }

        // If this was an invitation completion (and a password was provided),
        // ensure emailVerified is set and tenantUser promoted. Do NOT mark
        // verification for mere invite creation without password.
        if (data.guard && data.password && (data._invitationToken || data.token || data.invitationToken)) {
          try {
            await UserRepository.markEmailVerified(
              data.guard,
              { ...this.options, transaction, bypassPermissionValidation: true },
            );
            console.log('✅ [SecurityGuardService.create] ensured emailVerified for user id', data.guard);
          } catch (mvErr) {
            console.warn('⚠️ [SecurityGuardService.create] failed to mark email verified for user id', data.guard, mvErr && (mvErr as any).message ? (mvErr as any).message : mvErr);
          }
        }
      } catch (e) {
        console.warn('⚠️ [SecurityGuardService.create] post-create user sync encountered an error:', e && (e as any).message ? (e as any).message : e);
      }

      // After creating the securityGuard record, update pivot tables with securityGuardId if clientIds or postSiteIds were provided
      try {
        if ((data.clientIds || data.clientId || data.postSiteIds || data.postSiteId) && data.guard && record && record.id) {
          const currentTenant = SequelizeRepository.getCurrentTenant(this.options);
          const tenantId = currentTenant && currentTenant.id ? currentTenant.id : null;
          if (tenantId) {
            // Update pivot tables with the securityGuardId
            await TenantUserRepository.updateRoles(
              tenantId,
              data.guard,
              data.roles || [],
              { ...this.options, transaction, addRoles: true },
              data.clientIds ?? (data.clientId ? [data.clientId] : undefined),
              data.postSiteIds ?? (data.postSiteId ? [data.postSiteId] : undefined),
              record.id, // Pass the created securityGuardId
            );
            console.log('🔔 [SecurityGuardService.create] updated pivot tables with securityGuardId:', record.id);
          }
        }
      } catch (e) {
        console.warn('⚠️ [SecurityGuardService.create] failed to update pivot tables with securityGuardId:', (e && (e as any).message) ? (e as any).message : e);
      }

      await SequelizeRepository.commitTransaction(
        transaction,
      );

      return record;
    } catch (error) {
      await SequelizeRepository.rollbackTransaction(
        transaction,
      );

      SequelizeRepository.handleUniqueFieldError(
        error,
        this.options.language,
        'securityGuard',
      );

      throw error;
    }
  }

  async update(id, data) {
    // Normalize data to avoid TypeErrors when caller passes undefined
    data = data || {};
    const transaction = await SequelizeRepository.createTransaction(
      this.options.database,
    );

    try {
      data.guard = await UserRepository.filterIdInTenant(data.guard, { ...this.options, transaction });
      data.memos = await MemosRepository.filterIdsInTenant(data.memos, { ...this.options, transaction });
      data.requests = await RequestRepository.filterIdsInTenant(data.requests, { ...this.options, transaction });
      data.tutoriales = await CompletionOfTutorialRepository.filterIdsInTenant(data.tutoriales, { ...this.options, transaction });

      const record = await SecurityGuardRepository.update(
        id,
        data,
        {
          ...this.options,
          transaction,
        },
      );

      // Persist client/postSite assignments to tenant_user pivots if provided
      try {
        const currentTenant = SequelizeRepository.getCurrentTenant(this.options);
        const tenantId = currentTenant && currentTenant.id ? currentTenant.id : null;
        if (tenantId && data.guard && id) {
          await TenantUserRepository.updateRoles(
            tenantId,
            data.guard,
            data.roles || [],
            { ...this.options, transaction, addRoles: true },
            data.clientIds ?? (data.clientId ? [data.clientId] : undefined),
            data.postSiteIds ?? (data.postSiteId ? [data.postSiteId] : undefined),
            id, // Pass the securityGuardId (the `id` parameter is the securityGuard record ID)
          );
        }
      } catch (e) {
        // If pivot assignment fails, roll back the whole update
        console.error('Failed to persist client/postSite assignments during securityGuard update:', e);
        throw e;
      }

      await SequelizeRepository.commitTransaction(
        transaction,
      );

      return record;
    } catch (error) {
      await SequelizeRepository.rollbackTransaction(
        transaction,
      );

      SequelizeRepository.handleUniqueFieldError(
        error,
        this.options.language,
        'securityGuard',
      );

      throw error;
    }
  }

  async patchUpdate(id, data) {
    // Partial update flow: only apply fields present in `data` and update pivots/files if provided.
    data = data || {};
    const transaction = await SequelizeRepository.createTransaction(this.options.database);

    try {
      if (Object.prototype.hasOwnProperty.call(data, 'guard')) {
        data.guard = await UserRepository.filterIdInTenant(data.guard, { ...this.options, transaction });
      }

      if (Object.prototype.hasOwnProperty.call(data, 'memos')) {
        data.memos = await MemosRepository.filterIdsInTenant(data.memos, { ...this.options, transaction });
      }
      if (Object.prototype.hasOwnProperty.call(data, 'requests')) {
        data.requests = await RequestRepository.filterIdsInTenant(data.requests, { ...this.options, transaction });
      }
      if (Object.prototype.hasOwnProperty.call(data, 'tutoriales')) {
        data.tutoriales = await CompletionOfTutorialRepository.filterIdsInTenant(data.tutoriales, { ...this.options, transaction });
      }

      const record = await SecurityGuardRepository.patchUpdate(id, data, { ...this.options, transaction });

      // Persist client/postSite assignments to tenant_user pivots only if provided
      try {
        const currentTenant = SequelizeRepository.getCurrentTenant(this.options);
        const tenantId = currentTenant && currentTenant.id ? currentTenant.id : null;
        if (tenantId && Object.prototype.hasOwnProperty.call(data, 'guard') && id) {
          // Only update pivots when client/postSite ids are explicitly provided
          if (Object.prototype.hasOwnProperty.call(data, 'clientIds') || Object.prototype.hasOwnProperty.call(data, 'clientId') ||
              Object.prototype.hasOwnProperty.call(data, 'postSiteIds') || Object.prototype.hasOwnProperty.call(data, 'postSiteId')) {
            await TenantUserRepository.updateRoles(
              tenantId,
              data.guard,
              data.roles || [],
              { ...this.options, transaction, addRoles: true },
              data.clientIds ?? (data.clientId ? [data.clientId] : undefined),
              data.postSiteIds ?? (data.postSiteId ? [data.postSiteId] : undefined),
              id,
            );
          }
        }
      } catch (e) {
        console.error('Failed to persist client/postSite assignments during securityGuard patchUpdate:', e);
        throw e;
      }

      await SequelizeRepository.commitTransaction(transaction);

      return record;
    } catch (error) {
      await SequelizeRepository.rollbackTransaction(transaction);
      SequelizeRepository.handleUniqueFieldError(error, this.options.language, 'securityGuard');
      throw error;
    }
  }

  async destroyAll(ids) {
    const transaction = await SequelizeRepository.createTransaction(
      this.options.database,
    );

    try {
      for (const id of ids) {
        // Before destroying, ensure tenantUser status is 'archived'
        const record = await SecurityGuardRepository.findById(id, { ...this.options, transaction });

        const tenantUser = await TenantUserRepository.findByTenantAndUser(
          record.tenantId,
          record.guard && record.guard.id ? record.guard.id : record.guardId,
          { ...this.options, transaction },
        );

        if (!tenantUser || tenantUser.status !== 'archived') {
          throw new Error400(this.options.language, 'entities.securityGuard.errors.mustBeArchivedBeforeDelete');
        }

        // Validate not occupied before delete
        await this._ensureNotOccupied(record, { ...this.options, transaction });

        await SecurityGuardRepository.destroy(id, {
          ...this.options,
          transaction,
        });
      }

      await SequelizeRepository.commitTransaction(
        transaction,
      );
    } catch (error) {
      await SequelizeRepository.rollbackTransaction(
        transaction,
      );
      throw error;
    }
  }

  async archiveAll(ids) {
    const transaction = await SequelizeRepository.createTransaction(
      this.options.database,
    );

    try {
      for (const id of ids) {
        const record = await SecurityGuardRepository.findById(id, { ...this.options, transaction });

        // Validate not occupied
        await this._ensureNotOccupied(record, { ...this.options, transaction });

        // Update tenantUser.status to 'archived'
        const tenantUser = await TenantUserRepository.findByTenantAndUser(
          record.tenantId,
          record.guard && record.guard.id ? record.guard.id : record.guardId,
          { ...this.options, transaction },
        );

        if (!tenantUser) {
          throw new Error400(this.options.language, 'entities.securityGuard.errors.noTenantUser');
        }

        tenantUser.status = 'archived';
        await tenantUser.save({ transaction });
      }

      await SequelizeRepository.commitTransaction(
        transaction,
      );
    } catch (error) {
      await SequelizeRepository.rollbackTransaction(
        transaction,
      );
      throw error;
    }
  }

  // Helper: ensures a guard is not occupied (active shifts, guardShifts, or pending patrols)
  async _ensureNotOccupied(record, options) {
    const transaction = SequelizeRepository.getTransaction(options);
    const tenantId = record.tenantId;
    const securityGuardId = record.id;
    const guardUserId = record.guard && record.guard.id ? record.guard.id : record.guardId;

    // guardShift: ongoing if punchOutTime is null
    const guardShiftCount = await options.database.guardShift.count({
      where: {
        guardNameId: securityGuardId,
        tenantId,
        punchOutTime: null,
      },
      transaction,
    });

    if (guardShiftCount > 0) {
      throw new Error400(this.options.language, 'entities.securityGuard.errors.guardOccupiedByGuardShift');
    }

    // shift: ongoing if endTime is null or endTime > now
    const now = new Date();
    const shiftCount = await options.database.shift.count({
      where: {
        guardId: guardUserId,
        tenantId,
        [Sequelize.Op.or]: [
          { endTime: null },
          { endTime: { [Sequelize.Op.gt]: now } },
        ],
      },
      transaction,
    });

    if (shiftCount > 0) {
      throw new Error400(this.options.language, 'entities.securityGuard.errors.guardOccupiedByShift');
    }

    // patrol: not completed
    const patrolCount = await options.database.patrol.count({
      where: {
        assignedGuardId: guardUserId,
        tenantId,
        completed: false,
      },
      transaction,
    });

    if (patrolCount > 0) {
      throw new Error400(this.options.language, 'entities.securityGuard.errors.guardOccupiedByPatrol');
    }
  }

  async restoreAll(ids) {
    const transaction = await SequelizeRepository.createTransaction(
      this.options.database,
    );

    try {
      for (const id of ids) {
        await SecurityGuardRepository.restore(id, {
          ...this.options,
          transaction,
        });

        // After restoring the securityGuard record, also set the tenantUser.status to 'active'
        // so the user becomes active again in the tenant.
        const record = await SecurityGuardRepository.findById(id, { ...this.options, transaction });

        const tenantUser = await TenantUserRepository.findByTenantAndUser(
          record.tenantId,
          record.guard && record.guard.id ? record.guard.id : record.guardId,
          { ...this.options, transaction },
        );

        if (tenantUser) {
          tenantUser.status = 'active';
          await tenantUser.save({ transaction });
        }
      }

      await SequelizeRepository.commitTransaction(
        transaction,
      );
    } catch (error) {
      await SequelizeRepository.rollbackTransaction(
        transaction,
      );
      throw error;
    }
  }

  async findById(id) {
    return SecurityGuardRepository.findById(id, this.options);
  }

  async findAllAutocomplete(search, limit) {
    // First, get existing securityGuard records (these have additional profile data)
    const sgRecords = await SecurityGuardRepository.findAllAutocomplete(
      search,
      limit,
      this.options,
    );

    // Normalize to map keyed by underlying user id when available so that
    // securityGuard records and tenant_user entries referring to the same
    // user are deduplicated.
    const resultsMap: Map<string, string> = new Map();
    (sgRecords || []).forEach((r: any) => {
      if (!r) return;
      // If the securityGuard row references a user (guardId), prefer that as key
      const key = r.guardId ? String(r.guardId) : `sg:${String(r.id)}`;
      resultsMap.set(key, r.label || r.fullName || r.name || '');
    });

    // Also include tenant users who are active and have the securityGuard role
    try {
      const currentTenant = SequelizeRepository.getCurrentTenant(this.options);
      if (currentTenant && currentTenant.id) {
        const tenantUsers = await this.options.database.tenantUser.findAll({
          where: { tenantId: currentTenant.id, status: 'active' },
          include: [{ model: this.options.database.user, as: 'user' }],
        });

        for (const tu of (tenantUsers || [])) {
          const roles = tu.roles || [];
          const hasGuardRole = Array.isArray(roles) ? roles.includes(Roles.values.securityGuard) : false;
          if (hasGuardRole && tu.user && tu.user.id) {
            const id = String(tu.user.id);
            const label = tu.user.fullName || [tu.user.firstName, tu.user.lastName].filter(Boolean).join(' ') || tu.user.email || '';
            // If a search term exists, apply simple case-insensitive match
            if (!search || String(label).toLowerCase().includes(String(search || '').toLowerCase())) {
              // Set or overwrite the entry keyed by user id. This will replace
              // any securityGuard-derived entry that used the same user id key.
              resultsMap.set(id, label);
            }
          }
        }
      }
    } catch (e) {
      console.warn('securityGuardService.findAllAutocomplete: failed to include tenant users', e && (e as any).message ? (e as any).message : e);
    }

    // Convert map to array and apply limit
    const final = Array.from(resultsMap.entries()).map(([id, label]) => ({ id, label }));
    if (limit && final.length > Number(limit)) {
      return final.slice(0, Number(limit));
    }
    return final;
  }

  async findAndCountAll(args) {
    return SecurityGuardRepository.findAndCountAll(
      args,
      this.options,
    );
  }

  async import(data, importHash) {
    if (!importHash) {
      throw new Error400(
        this.options.language,
        'importer.errors.importHashRequired',
      );
    }

    if (await this._isImportHashExistent(importHash)) {
      throw new Error400(
        this.options.language,
        'importer.errors.importHashExistent',
      );
    }

    // Support importing a single record or an array of records (rows)
    if (Array.isArray(data)) {
      const results: any[] = [];
      for (const row of data) {
        const rowToCreate = { ...row, importHash };
        const created = await this.create(rowToCreate);
        results.push(created);
      }
      return results;
    }

    if (data && Array.isArray(data.rows)) {
      const results: any[] = [];
      for (const row of data.rows) {
        const rowToCreate = { ...row, importHash };
        const created = await this.create(rowToCreate);
        results.push(created);
      }
      return results;
    }

    const dataToCreate = {
      ...data,
      importHash,
    };

    return this.create(dataToCreate);
  }

  async _isImportHashExistent(importHash) {
    const count = await SecurityGuardRepository.count(
      {
        importHash,
      },
      this.options,
    );

    return count > 0;
  }

  async exportToFile(format, filter = {}) {
    const { rows } = await SecurityGuardRepository.findAndCountAll(
      { filter, limit: 0, offset: 0, orderBy: 'fullName_ASC' },
      this.options,
    );

    try {
      console.log('🔔 [SecurityGuardService.exportToFile] rows count:', rows && rows.length ? rows.length : 0);
      if (rows && rows.length) {
        const sampleKeys = Object.keys(rows[0] || {}).slice(0, 20);
        console.log('🔔 [SecurityGuardService.exportToFile] sample row keys:', sampleKeys);
      }
    } catch (e) {
      console.warn('🔔 [SecurityGuardService.exportToFile] failed to log rows sample:', (e && (e as any).message) ? (e as any).message : e);
    }

    if (format === 'pdf') {
      return this._generatePDF(rows);
    } else if (format === 'excel') {
      return this._generateExcel(rows);
    }

    throw new Error400(
      this.options.language,
      'Formato no soportado',
    );
  }

  async _generatePDF(guards) {
    const PDFDocument = require('pdfkit');

    return new Promise((resolve, reject) => {
      try {
        const doc = new PDFDocument({ margin: 20, size: 'A3', layout: 'landscape', bufferPages: true });
        const chunks: Buffer[] = [];

        doc.on('data', chunk => chunks.push(chunk));
        doc.on('end', () => resolve(Buffer.concat(chunks)));

        const pageWidth = doc.page.width;
        const pageHeight = doc.page.height;
        const marginLeft = 20;
        const marginRight = 20;
        const usableWidth = pageWidth - marginLeft - marginRight;

        doc.fontSize(20).font('Helvetica-Bold').text('Lista de Guardias', marginLeft, 20, { width: usableWidth, align: 'center' });
        doc.fontSize(10).font('Helvetica').text(`Fecha: ${new Date().toLocaleDateString()}`, marginLeft, 50, { width: usableWidth, align: 'right' });

        const tableTop = 80;
        const fontSize = 9;
        doc.fontSize(fontSize).font('Helvetica-Bold');

        // Columns covering all requested fields with weights for widths
        const colDefs = [
          { label: 'Nombre', key: 'fullName', weight: 3 },
          { label: 'Correo', key: 'email', weight: 3 },
          { label: 'Teléfono', key: 'phoneNumber', weight: 2 },
          { label: 'Estado', key: 'status', weight: 2 },
          { label: 'Cédula', key: 'governmentId', weight: 2 },
          { label: 'Fecha Contrato', key: 'hiringContractDate', weight: 2 },
          { label: 'Género', key: 'gender', weight: 1.5 },
          { label: 'Tipo Sangre', key: 'bloodType', weight: 1.5 },
          { label: 'Credenciales', key: 'guardCredentials', weight: 2.5 },
          { label: 'Fecha Nac.', key: 'birthDate', weight: 2 },
          { label: 'Lugar Nac.', key: 'birthPlace', weight: 2 },
          { label: 'Estado Civ.', key: 'maritalStatus', weight: 1.5 },
          { label: 'Educación', key: 'academicInstruction', weight: 2 },
          { label: 'Dirección', key: 'address', weight: 4 },
        ];

        const totalWeight = colDefs.reduce((s, c) => s + c.weight, 0);
        let cursorX = marginLeft;
        const cols = colDefs.map((c) => {
          const w = (usableWidth * c.weight) / totalWeight;
          const out = { label: c.label, key: c.key, x: cursorX, width: w };
          cursorX += w;
          return out;
        });

        cols.forEach(col => {
          doc.text(col.label, col.x, tableTop, { width: col.width, align: 'left', lineBreak: false });
        });

        const lineY = tableTop + 15;
        doc.moveTo(marginLeft, lineY).lineTo(pageWidth - marginRight, lineY).stroke();

        const firstRowY = lineY + 10;
        doc.font('Helvetica');
        let currentY = firstRowY;

        guards.forEach((g) => {
          if (currentY > pageHeight - 80) {
            doc.addPage();
            currentY = 40;
            doc.fontSize(fontSize).font('Helvetica-Bold');
            cols.forEach(col => {
              doc.text(col.label, col.x, currentY, { width: col.width, align: 'left', lineBreak: false });
            });
            doc.moveTo(marginLeft, currentY + 15).lineTo(pageWidth - marginRight, currentY + 15).stroke();
            currentY += 23;
            doc.font('Helvetica');
          }

          // Prepare values for each column key
          const name = (g.fullName || `${g.firstName || ''} ${g.lastName || ''}`).trim();
          const status = (g.status === 'active' || g.status === 'archived' || g.status === 'pending' || g.status === 'invited') ? g.status : (g.guard && g.guard.status) || '';
          const statusMap: any = {
            active: 'Activo',
            invited: 'Invitado',
            pending: 'Pendiente',
            archived: 'Archivado',
          };
          const email = g.email || (g.guard && (g.guard.email || g.guard.username)) || '';
          const phoneNumber = g.phoneNumber || g.phone || (g.guard && (g.guard.phoneNumber || g.guard.phone)) || '';
          const values = {
              fullName: name || '',
              email,
              phoneNumber,
              status: status ? (statusMap[status] || (String(status).charAt(0).toUpperCase() + String(status).slice(1))) : '',
              governmentId: g.governmentId || '',
              hiringContractDate: g.hiringContractDate ? new Date(g.hiringContractDate).toLocaleDateString() : '',
              gender: g.gender || (g.guard && g.guard.gender) || '',
              bloodType: g.bloodType || '',
              guardCredentials: g.guardCredentials || '',
              birthDate: g.birthDate ? new Date(g.birthDate).toLocaleDateString() : '',
              birthPlace: g.birthPlace || '',
              maritalStatus: g.maritalStatus || '',
              academicInstruction: g.academicInstruction || '',
              address: g.address || '',
            };

          doc.fontSize(8);
          cols.forEach(col => {
            const text = String(values[col.key] || '');
            doc.text(text, col.x, currentY, { width: col.width - 6, lineBreak: false, ellipsis: true });
          });

          currentY += 18;
        });

        const range = doc.bufferedPageRange();
        const totalPages = range.count;
        for (let i = 0; i < totalPages; i++) {
          doc.switchToPage(range.start + i);
          doc.fontSize(9).font('Helvetica');
          const footerText = `Página ${i + 1} de ${totalPages}`;
          const textWidth = doc.widthOfString(footerText);
          const footerX = marginLeft + (usableWidth - textWidth) / 2;
          const footerY = pageHeight - 30;
          doc.text(footerText, footerX, footerY, { lineBreak: false, continued: false });
        }

        doc.end();
      } catch (error) {
        reject(error);
      }
    });
  }

  async _generateExcel(guards) {
    const ExcelJS = require('exceljs');
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Guardias');

    // Title and date
    const lastCol = 'N';
    worksheet.mergeCells(`A1:${lastCol}1`);
    const titleCell = worksheet.getCell('A1');
    titleCell.value = 'Lista de Guardias';
    titleCell.font = { bold: true, size: 16 };
    titleCell.alignment = { vertical: 'middle', horizontal: 'center' };

    worksheet.mergeCells(`A2:${lastCol}2`);
    worksheet.getCell('A2').value = `Fecha: ${new Date().toLocaleDateString()}`;

    const headerRow = worksheet.getRow(4);
    const headers = ['Nombre', 'Correo', 'Teléfono', 'Estado', 'Cédula', 'Fecha Contrato', 'Género', 'Tipo Sangre', 'Credenciales', 'Fecha Nac.', 'Lugar Nac.', 'Estado Civ.', 'Educación', 'Dirección'];
    const widths = [40, 35, 20, 15, 20, 18, 12, 12, 20, 15, 20, 15, 18, 50];

    headers.forEach((header, index) => {
      const cell = headerRow.getCell(index + 1);
      cell.value = header;
      cell.font = { bold: true };
      worksheet.getColumn(index + 1).width = widths[index];
    });

    let currentRow = 5;
    guards.forEach(g => {
      const row = worksheet.getRow(currentRow);
      const name = (g.fullName || `${g.firstName || ''} ${g.lastName || ''}`).trim();
      const status = (g.status === 'active' || g.status === 'archived' || g.status === 'pending' || g.status === 'invited') ? g.status : (g.guard && g.guard.status) || '';
      const statusMap: any = {
        active: 'Activo',
        invited: 'Invitado',
        pending: 'Pendiente',
        archived: 'Archivado',
      };

      const maritalMap: any = {
        soltero: 'Soltero',
        soltera: 'Soltera',
        casado: 'Casado',
        casada: 'Casada',
        divorciado: 'Divorciado',
        divorciada: 'Divorciada',
        viudo: 'Viudo',
        viuda: 'Viuda',
      };

      const genderMap: any = {
        masculino: 'Masculino',
        femenino: 'Femenino',
        other: 'Otro',
        otro: 'Otro',
      };


      const statusLabel = status ? (statusMap[status] || String(status).charAt(0).toUpperCase() + String(status).slice(1)) : '';
      const hiring = g.hiringContractDate ? new Date(g.hiringContractDate).toLocaleDateString() : '';
      const birth = g.birthDate ? new Date(g.birthDate).toLocaleDateString() : '';
      const genderLabel = g.gender ? (genderMap[String(g.gender).toLowerCase()] || g.gender) : (g.guard && g.guard.gender) || '';
      const maritalLabel = g.maritalStatus ? (maritalMap[String(g.maritalStatus).toLowerCase()] || g.maritalStatus) : '';

      const email = g.email || (g.guard && (g.guard.email || g.guard.username)) || '';
      const phone = g.phoneNumber || g.phone || (g.guard && (g.guard.phoneNumber || g.guard.phone)) || '';

      row.values = [
        name || '',
        email,
        phone,
        statusLabel,
        g.governmentId || '',
        hiring,
        genderLabel,
        g.bloodType || '',
        g.guardCredentials || '',
        birth,
        g.birthPlace || '',
        maritalLabel,
        g.academicInstruction || '',
        g.address || '',
      ];

      currentRow++;
    });

    return await workbook.xlsx.writeBuffer();
  }
}
