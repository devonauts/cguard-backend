import TenantRepository from '../database/repositories/tenantRepository';
import TenantUserRepository from '../database/repositories/tenantUserRepository';
import TenantInvitationRepository from '../database/repositories/tenantInvitationRepository';
import Error400 from '../errors/Error400';
import SequelizeRepository from '../database/repositories/sequelizeRepository';
import PermissionChecker from './user/permissionChecker';
import Permissions from '../security/permissions';
import Error404 from '../errors/Error404';
import { getConfig } from '../config';
import Roles from '../security/roles';
import SettingsService from './settingsService';
import Plans from '../security/plans';
import { IServiceOptions } from './IServiceOptions';

export default class TenantService {
  options: IServiceOptions;

  constructor(options) {
    this.options = options;
  }

  /**
   * Creates the default tenant or joins the default with roles passed.
   * 
   * 🏢 MODO ACTUAL: SINGLE TENANT (Una sola empresa)
   * - Todos los usuarios comparten el mismo tenant
   * - Ideal para una empresa con múltiples empleados
   * 
   * 🔄 PARA CAMBIAR A MULTI-TENANT (Plataforma digital para múltiples empresas):
   * - Descomentar el bloque "MULTI-TENANT MODE" abajo
   * - Comentar el bloque "SINGLE TENANT MODE"
   * - Cada usuario tendrá su propio tenant aislado
   */
  async createOrJoinDefault({ roles }, transaction) {
    // ========================================
    // 🟢 SINGLE TENANT MODE (ACTIVO)
    // ========================================
    const tenant = await TenantRepository.findDefault({
      ...this.options,
      transaction,
    });

    if (tenant) {
      const tenantUser = await TenantUserRepository.findByTenantAndUser(
        tenant.id,
        this.options.currentUser.id,
        {
          ...this.options,
          transaction,
        },
      );

      // In this situation, the user has used the invitation token
      // and it is already part of the tenant
      if (tenantUser) {
        return;
      }

      return await TenantUserRepository.create(
        tenant,
        this.options.currentUser,
        roles,
        { ...this.options, transaction },
      );
    }

    let record = await TenantRepository.create(
      { name: 'default', url: 'default' },
      {
        ...this.options,
        transaction,
      },
    );

    await SettingsService.findOrCreateDefault({
      ...this.options,
      currentTenant: record,
      transaction,
    });

    await TenantUserRepository.create(
      record,
      this.options.currentUser,
      [Roles.values.admin],
      {
        ...this.options,
        transaction,
      },
    );
    // ========================================
    // FIN SINGLE TENANT MODE
    // ========================================

    /* ========================================
     * 🔵 MULTI-TENANT MODE (COMENTADO)
     * ========================================
     * Descomentar este bloque para convertir la aplicación en una
     * plataforma digital donde cada empresa tiene su propio tenant.
     * 
     * Cada usuario que se registre creará automáticamente su propia
     * organización con datos completamente aislados.
     * ========================================
    
    // Check if user already has a tenant
    const existingTenantUser = await TenantUserRepository.findByUser(
      this.options.currentUser.id,
      {
        ...this.options,
        transaction,
      },
    );

    // If user already belongs to a tenant, don't create a new one
    if (existingTenantUser && existingTenantUser.length > 0) {
      console.log('👤 Usuario ya tiene tenant, no se crea uno nuevo');
      return;
    }

    // Create a unique tenant name for this user
    const tenantName = `${this.options.currentUser.email.split('@')[0]}-org`;
    const tenantUrl = `${this.options.currentUser.id.substring(0, 8)}`;

    console.log('🏢 Creando nuevo tenant para usuario:', this.options.currentUser.email);
    console.log('📝 Nombre del tenant:', tenantName);

    let record = await TenantRepository.create(
      { name: tenantName, url: tenantUrl },
      {
        ...this.options,
        transaction,
      },
    );

    await SettingsService.findOrCreateDefault({
      ...this.options,
      currentTenant: record,
      transaction,
    });

    await TenantUserRepository.create(
      record,
      this.options.currentUser,
      [Roles.values.admin],
      {
        ...this.options,
        transaction,
      },
    );

    console.log('✅ Tenant creado con ID:', record.id);
    
     * ========================================
     * FIN MULTI-TENANT MODE
     * ======================================== */
  }

  async joinWithDefaultRolesOrAskApproval(
    { roles, tenantId },
    { transaction },
  ) {
    const tenant = await TenantRepository.findById(
      tenantId,
      {
        ...this.options,
        transaction,
      },
    );

    const tenantUser = await TenantUserRepository.findByTenantAndUser(
      tenant.id,
      this.options.currentUser.id,
      {
        ...this.options,
        transaction,
      },
    );

    if (tenantUser) {
      // If found the invited tenant user via email
      // accepts the invitation
      if (tenantUser.status === 'invited') {
        return await TenantUserRepository.acceptInvitation(
          tenantUser.invitationToken,
          {
            ...this.options,
            transaction,
          },
        );
      }

      // In this case the tenant user already exists
      // and it's accepted or with empty permissions
      return;
    }

    return await TenantUserRepository.create(
      tenant,
      this.options.currentUser,
      roles,
      { ...this.options, transaction },
    );
  }

  // In case this user has been invited
  // but havent used the invitation token
  async joinDefaultUsingInvitedEmail(transaction) {
    const tenant = await TenantRepository.findDefault({
      ...this.options,
      transaction,
    });

    if (!tenant) {
      return;
    }

    const tenantUser = await TenantUserRepository.findByTenantAndUser(
      tenant.id,
      this.options.currentUser.id,
      {
        ...this.options,
        transaction,
      },
    );

    if (!tenantUser || tenantUser.status !== 'invited') {
      return;
    }

    return await TenantUserRepository.acceptInvitation(
      tenantUser.invitationToken,
      {
        ...this.options,
        transaction,
      },
    );
  }

  async create(data) {
    const transaction = await SequelizeRepository.createTransaction(
      this.options.database,
    );

    try {
      if (getConfig().TENANT_MODE === 'single') {
        const count = await TenantRepository.count(null, {
          ...this.options,
          transaction,
        });

        if (count > 0) {
          throw new Error400(
            this.options.language,
            'tenant.exists',
          );
        }
      }

      let record = await TenantRepository.create(data, {
        ...this.options,
        transaction,
      });

      await SettingsService.findOrCreateDefault({
        ...this.options,
        currentTenant: record,
        transaction,
      });

      await TenantUserRepository.create(
        record,
        this.options.currentUser,
        [Roles.values.admin],
        {
          ...this.options,
          transaction,
        },
      );

      await SequelizeRepository.commitTransaction(
        transaction,
      );

      return record;
    } catch (error) {
      await SequelizeRepository.rollbackTransaction(
        transaction,
      );
      throw error;
    }
  }

  async update(id, data) {
    const transaction = await SequelizeRepository.createTransaction(
      this.options.database,
    );

    try {
      let record = await TenantRepository.findById(id, {
        ...this.options,
        transaction,
        currentTenant: { id },
      });

      new PermissionChecker({
        ...this.options,
        currentTenant: { id },
      }).validateHas(Permissions.values.tenantEdit);

      record = await TenantRepository.update(id, data, {
        ...this.options,
        transaction,
        currentTenant: record,
      });

      await SequelizeRepository.commitTransaction(
        transaction,
      );

      return record;
    } catch (error) {
      await SequelizeRepository.rollbackTransaction(
        transaction,
      );
      throw error;
    }
  }

  async updatePlanUser(
    id,
    planStripeCustomerId,
    planUserId,
  ) {
    const transaction = await SequelizeRepository.createTransaction(
      this.options.database,
    );

    try {
      await TenantRepository.updatePlanUser(
        id,
        planStripeCustomerId,
        planUserId,
        {
          ...this.options,
          transaction,
          currentTenant: { id },
          bypassPermissionValidation: true,
        },
      );

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

  async updatePlanToFree(planStripeCustomerId) {
    return this.updatePlanStatus(
      planStripeCustomerId,
      Plans.values.free,
      'active',
    );
  }

  async updatePlanStatus(
    planStripeCustomerId,
    plan,
    planStatus,
  ) {
    const transaction = await SequelizeRepository.createTransaction(
      this.options.database,
    );

    try {
      await TenantRepository.updatePlanStatus(
        planStripeCustomerId,
        plan,
        planStatus,
        {
          ...this.options,
          transaction,
          bypassPermissionValidation: true,
        },
      );

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

  async destroyAll(ids) {
    const transaction = await SequelizeRepository.createTransaction(
      this.options.database,
    );

    try {
      for (const id of ids) {
        const tenant = await TenantRepository.findById(id, {
          ...this.options,
          transaction,
          currentTenant: { id },
        });

        new PermissionChecker({
          ...this.options,
          currentTenant: tenant,
        }).validateHas(Permissions.values.tenantDestroy);

        if (
          !Plans.allowTenantDestroy(
            tenant.plan,
            tenant.planStatus,
          )
        ) {
          throw new Error400(
            this.options.language,
            'tenant.planActive',
          );
        }

        await TenantRepository.destroy(id, {
          ...this.options,
          transaction,
          currentTenant: { id },
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

  async findById(id, options?) {
    options = options || {};

    return TenantRepository.findById(id, {
      ...this.options,
      ...options,
    });
  }

  async findByUrl(url, options?) {
    options = options || {};

    return TenantRepository.findByUrl(url, {
      ...this.options,
      ...options,
    });
  }

  async findAllAutocomplete(search, limit) {
    return TenantRepository.findAllAutocomplete(
      search,
      limit,
      this.options,
    );
  }

  async findAndCountAll(args) {
    return TenantRepository.findAndCountAll(
      args,
      this.options,
    );
  }

  async acceptInvitation(
    token,
    forceAcceptOtherEmail = false,
  ) {
    const transaction = await SequelizeRepository.createTransaction(
      this.options.database,
    );

    try {
      // First, check standalone tenant invitations table
      const standaloneInvite = await TenantInvitationRepository.findByToken(token, {
        ...this.options,
        transaction,
      });

      if (standaloneInvite) {
        // If there's already a tenantUser for this tenant and current user, activate/merge; otherwise create
        const tenantId = standaloneInvite.tenantId || (standaloneInvite.tenant && standaloneInvite.tenant.id);
        if (!tenantId) {
          throw new Error404();
        }

        const existing = await TenantUserRepository.findByTenantAndUser(
          tenantId,
          this.options.currentUser.id,
          { ...this.options, transaction },
        );

        if (existing) {
          existing.invitationToken = null;
          existing.invitationTokenExpiresAt = null;
          existing.status = existing.status || 'active';
          await existing.save({ transaction });
        } else {
          // Try a fallback lookup: the user may have an existing tenant_user row
          // created with a NULL tenantId (legacy / malformed). Prefer updating
          // that row instead of creating a duplicate.
          let fallbackTenantUser: any = null;
          try {
            const allForUser = await TenantUserRepository.findByUser(this.options.currentUser.id, { ...this.options, transaction });
            if (Array.isArray(allForUser) && allForUser.length) {
              // prefer one with null tenantId, otherwise none
              fallbackTenantUser = allForUser.find((r) => !r.tenantId) || null;
            }
          } catch (e) {
            // non-fatal: proceed to create if lookup fails
            fallbackTenantUser = null;
          }

          if (fallbackTenantUser) {
            // update the legacy row to point to the correct tenant and activate
            fallbackTenantUser.tenantId = tenantId;
            fallbackTenantUser.invitationToken = null;
            fallbackTenantUser.invitationTokenExpiresAt = null;
            fallbackTenantUser.roles = [ ...(Array.isArray(fallbackTenantUser.roles) ? fallbackTenantUser.roles : [] ) ];
            fallbackTenantUser.status = fallbackTenantUser.status || 'active';
            await fallbackTenantUser.save({ transaction });
          } else {
            // create tenantUser record for current user
            const tenant = standaloneInvite.tenant || await TenantRepository.findById(tenantId, { ...this.options, transaction });
            await TenantUserRepository.create(
              tenant,
              this.options.currentUser,
              [],
              { ...this.options, transaction, currentTenant: { id: tenantId } },
            );
          }
        }

        // consume the standalone invitation
        await TenantInvitationRepository.consume(token, { ...this.options, transaction });

        await SequelizeRepository.commitTransaction(transaction);
        return standaloneInvite.tenant || (await TenantRepository.findById(tenantId, this.options));
      }

      // Fallback: legacy flow where invitation token was stored on tenantUser row
      const tenantUser = await TenantUserRepository.findByInvitationToken(
        token,
        {
          ...this.options,
          transaction,
        },
      );

      if (!tenantUser || tenantUser.status !== 'invited') {
        throw new Error404();
      }

      const isNotCurrentUserEmail =
        tenantUser.user.id !== this.options.currentUser.id;

      if (!forceAcceptOtherEmail && isNotCurrentUserEmail) {
        throw new Error400(
          this.options.language,
          'tenant.invitation.notSameEmail',
          tenantUser.user.email,
          this.options.currentUser.email,
        );
      }

      await TenantUserRepository.acceptInvitation(token, {
        ...this.options,
        currentTenant: { id: tenantUser.tenant.id },
        transaction,
      });

      await SequelizeRepository.commitTransaction(
        transaction,
      );

      return tenantUser.tenant;
    } catch (error) {
      await SequelizeRepository.rollbackTransaction(
        transaction,
      );

      throw error;
    }
  }

  async declineInvitation(token) {
    const transaction = await SequelizeRepository.createTransaction(
      this.options.database,
    );

    try {
      const tenantUser = await TenantUserRepository.findByInvitationToken(
        token,
        {
          ...this.options,
          transaction,
        },
      );

      if (!tenantUser || tenantUser.status !== 'invited') {
        throw new Error404();
      }

      await TenantUserRepository.destroy(
        tenantUser.tenant.id,
        this.options.currentUser.id,
        {
          ...this.options,
          transaction,
          currentTenant: { id: tenantUser.tenant.id },
        },
      );

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

    const dataToCreate = {
      ...data,
      importHash,
    };

    return this.create(dataToCreate);
  }

  async _isImportHashExistent(importHash) {
    const count = await TenantRepository.count(
      {
        importHash,
      },
      this.options,
    );

    return count > 0;
  }
}
