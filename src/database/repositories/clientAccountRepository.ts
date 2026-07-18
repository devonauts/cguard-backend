import SequelizeRepository from '../../database/repositories/sequelizeRepository';
import AuditLogRepository from '../../database/repositories/auditLogRepository';
import FileRepository from '../../database/repositories/fileRepository';
import { batchSignFiles } from '../../database/utils/listQuery';
import lodash from 'lodash';
import SequelizeFilterUtils from '../../database/utils/sequelizeFilterUtils';
import Error404 from '../../errors/Error404';
import Error400 from '../../errors/Error400';
import Sequelize from 'sequelize';
import Roles from '../../security/roles';
import { IRepositoryOptions } from './IRepositoryOptions';

const Op = Sequelize.Op;

// Explicit column whitelist for the LEAN list path (see findAndCountAll).
// Every entry is verified against src/database/models/clientAccount.ts. Only
// scalars the list/consumers actually read — no big blobs, no file relations.
const LIST_ATTRIBUTES = [
  'id',
  'name',
  'commercialName',
  'lastName',
  'email',
  'phoneNumber',
  'personType',
  'documentNumber',
  'address',
  'addressComplement',
  'zipCode',
  'city',
  'country',
  'faxNumber',
  'landline',
  'website',
  'contractDate',
  'contractEndDate',
  'riskLevel',
  'code',
  'accountExecutiveId',
  'legalRepFirstName',
  'legalRepLastName',
  'legalRepEmail',
  'legalRepPhone',
  'legalRepDocument',
  'latitude',
  'longitude',
  'useSameAddressForBilling',
  'userId',
  'categoryIds',
  'active',
  'onboardingStatus',
  'createdAt',
  'updatedAt',
  'deletedAt',
];

class ClientAccountRepository {

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

    // Validate uniqueness of email within the tenant.
    // Phone numbers are intentionally NOT unique — multiple clients may share a
    // phone (e.g. sites behind the same switchboard).
    try {
      const email = (data.email || '').toString().trim().toLowerCase();
      if (email) {
        const existing = await options.database.clientAccount.findOne({
          where: {
            tenantId: tenant.id,
            email,
          },
          transaction,
        });
        if (existing) {
          console.warn('ClientAccount create validation: duplicate email detected', { existingId: existing.id, email: existing.email });
          const err = new Error400(options.language, 'entities.clientAccount.errors.exists');
          (err as any).errors = { existingId: existing.id, conflictField: 'email', email: existing.email };
          throw err;
        }
      }
    } catch (err) {
      if (err instanceof Error400) throw err;
      // if DB check failed unexpectedly, continue and let create surface the error
    }

    const normalizedData = {
      ...data,
      name: data?.name || data?.commercialName,
    };

    // clientAccount.name/lastName/email/phoneNumber are a DENORMALIZED CACHE
    // synced from the linked user (single source of identity) — do not edit them
    // independently. If a user is already linked at creation, derive the cache
    // FROM that user. Otherwise the provided values act as staging until the
    // user is provisioned (CustomerIdentityService) and the cache is reconciled.
    try {
      if (normalizedData.userId) {
        const linkedUser = await options.database.user.findByPk(
          normalizedData.userId,
          { transaction },
        );
        if (linkedUser) {
          const firstName = (linkedUser.firstName || '').toString().trim();
          const lastName = (linkedUser.lastName || '').toString().trim();
          const email = (linkedUser.email || '').toString().trim();
          const phoneNumber = (linkedUser.phoneNumber || '').toString().trim();
          if (firstName) (normalizedData as any).name = firstName;
          (normalizedData as any).lastName = lastName || null;
          (normalizedData as any).email = email || null;
          (normalizedData as any).phoneNumber = phoneNumber || null;
        }
      }
    } catch (e) {
      console.warn(
        'clientAccountRepository.create: could not derive identity from user',
        (e && (e as any).message) || e,
      );
    }

    const record = await options.database.clientAccount.create(
      {
        // Allow caller to force the id when needed (e.g., keep same id as user)
        id: data && data.id ? data.id : undefined,
        ...lodash.pick(normalizedData, [
          'name',
          'commercialName',
          'lastName',
          'email',
          'userId',
          'personType',
          'documentNumber',
          'phoneNumber',
          'address',
          'addressComplement',
          'zipCode',
          'city',
          'country',
          'useSameAddressForBilling',
          'faxNumber',
          'landline',
          'website',
        'contractDate',
          'contractEndDate',
          'riskLevel',
          'code',
          'accountExecutiveId',
          'legalRepFirstName',
          'legalRepLastName',
          'legalRepEmail',
          'legalRepPhone',
          'legalRepDocument',
              'latitude',
              'longitude',
          'importHash',
          'categoryIds',
          'active',
        ]),
        tenantId: tenant.id,
        createdById: currentUser.id,
        updatedById: currentUser.id,
      },
      {
        transaction,
      },
    );

    await FileRepository.replaceRelationFiles(
      {
        belongsTo: options.database.clientAccount.getTableName(),
        belongsToColumn: 'logoUrl',
        belongsToId: record.id,
      },
      data.logoUrl,
      options,
    );

    await FileRepository.replaceRelationFiles(
      {
        belongsTo: options.database.clientAccount.getTableName(),
        belongsToColumn: 'placePictureUrl',
        belongsToId: record.id,
      },
      data.placePictureUrl,
      options,
    );

    await this._createAuditLog(
      AuditLogRepository.CREATE,
      record,
      data,
      options,
    );

    // After create, bypass permission validation for the immediate read-back
    // so creators with create permission can receive the created record
    // even if they are not assigned to it yet.
    return this.findById(record.id, { ...options, bypassPermissionValidation: true });
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

    let record = await options.database.clientAccount.findOne(
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

    console.log('📤 Data recibida del controlador:', data);
    console.log('📤 Data recibida (active):', data.active);

    const normalizedData = {
      ...data,
      name: data?.name || data?.commercialName,
    };

    const updateData = {
      ...lodash.pick(normalizedData, [
        'name',
        'commercialName',
        'lastName',
        'userId',
        'email',
        'personType',
        'documentNumber',
        'phoneNumber',
        'address',
        'addressComplement',
        'zipCode',
        'city',
        'country',
        'useSameAddressForBilling',
        'faxNumber',
        'landline',
        'website',
        'contractDate',
        'contractEndDate',
        'riskLevel',
        'code',
        'accountExecutiveId',
        'legalRepFirstName',
        'legalRepLastName',
        'legalRepEmail',
        'legalRepPhone',
        'legalRepDocument',
        'latitude',
        'longitude',
        'importHash',
        'categoryIds',
        'active',
      ]),
      updatedById: currentUser.id,
    };

    // clientAccount.name/lastName/email/phoneNumber are a DENORMALIZED CACHE
    // synced from the linked user (single source of identity). Ignoring the
    // request values silently REVERTED every admin rename (Seguridad BAS: the
    // site changed manager, saved the new name 6 times, it always came back).
    // Correct behaviour: when the admin edits identity fields, propagate them
    // TO the linked user first (email only when globally free), then derive
    // back as before — so every denormalized copy follows.
    {
      const linkedUserId = (updateData as any).userId || record.userId;
      if (linkedUserId) {
        const linkedUser = await options.database.user.findByPk(linkedUserId, { transaction });
        if (linkedUser) {
          const patch: any = {};
          const reqName = (data?.name || data?.commercialName || '').toString().trim();
          const reqLast =
            typeof data?.lastName !== 'undefined' ? (data.lastName || '').toString().trim() : undefined;
          const reqPhone =
            typeof data?.phoneNumber !== 'undefined' ? (data.phoneNumber || '').toString().trim() : undefined;
          const reqEmail =
            typeof data?.email !== 'undefined' && data.email
              ? data.email.toString().trim().toLowerCase()
              : undefined;

          if (reqName && reqName !== (linkedUser.firstName || '').toString().trim()) {
            patch.firstName = reqName;
          }
          if (reqLast !== undefined && reqLast !== (linkedUser.lastName || '').toString().trim()) {
            patch.lastName = reqLast || null;
          }
          if (reqPhone !== undefined && reqPhone !== (linkedUser.phoneNumber || '').toString().trim()) {
            patch.phoneNumber = reqPhone || null;
          }
          if (reqEmail && reqEmail !== (linkedUser.email || '').toString().trim().toLowerCase()) {
            // users.email is the login — only take it when no other account owns it.
            const taken = await options.database.user.findOne({
              where: { email: reqEmail, id: { [Op.ne]: linkedUser.id } },
              transaction,
            });
            if (taken) {
              throw new Error400(
                options.language,
                'errors.validation.message',
                'Ese correo ya pertenece a otra cuenta. Usa un correo distinto para el cliente.',
              );
            }
            patch.email = reqEmail;
          }

          if (Object.keys(patch).length) {
            if (patch.firstName !== undefined || patch.lastName !== undefined) {
              const f = (patch.firstName ?? linkedUser.firstName ?? '').toString().trim();
              const l = ((patch.lastName === undefined ? linkedUser.lastName : patch.lastName) ?? '')
                .toString()
                .trim();
              patch.fullName = `${f} ${l}`.trim() || null;
            }
            await linkedUser.update(patch, { transaction });
            // Fan the new identity out to every denormalized copy (guard rows,
            // other clientAccounts of this user, etc.). Best-effort.
            try {
              const { syncIdentityFromUser } = require('../../services/identitySync');
              await syncIdentityFromUser(options.database, linkedUser.id, options);
            } catch (e) {
              console.warn('clientAccountRepository.update: identity fan-out failed', (e as any)?.message || e);
            }
          }
        }
      }
    }

    try {
      const linkedUserId = (updateData as any).userId || record.userId;
      if (linkedUserId) {
        const linkedUser = await options.database.user.findByPk(linkedUserId, {
          transaction,
        });
        if (linkedUser) {
          const firstName = (linkedUser.firstName || '').toString().trim();
          const lastName = (linkedUser.lastName || '').toString().trim();
          const email = (linkedUser.email || '').toString().trim();
          const phoneNumber = (linkedUser.phoneNumber || '').toString().trim();
          // name is NOT NULL — only override when we actually have a value.
          if (firstName) (updateData as any).name = firstName;
          (updateData as any).lastName = lastName || null;
          (updateData as any).email = email || null;
          (updateData as any).phoneNumber = phoneNumber || null;
        }
      }
    } catch (e) {
      console.warn(
        'clientAccountRepository.update: could not derive identity from user',
        (e && (e as any).message) || e,
      );
    }

    // Validate uniqueness of email within the tenant (exclude self).
    // Phone numbers are intentionally NOT unique — multiple clients may share a phone.
    try {
      const email =
        typeof updateData.email !== 'undefined'
          ? (updateData.email || '').toString().trim().toLowerCase()
          : '';
      if (email) {
        const existing = await options.database.clientAccount.findOne({
          where: {
            tenantId: currentTenant.id,
            id: { [Op.ne]: id },
            email,
          },
          transaction,
        });
        if (existing) {
          console.warn('ClientAccount update validation: duplicate email detected', { existingId: existing.id, email: existing.email });
          const err = new Error400(options.language, 'entities.clientAccount.errors.exists');
          (err as any).errors = { existingId: existing.id, conflictField: 'email', email: existing.email };
          throw err;
        }
      }
    } catch (err) {
      if (err instanceof Error400) throw err;
    }

    console.log('📥 UpdateData a guardar:', updateData);
    console.log('📥 UpdateData (active):', updateData.active);
    console.log('📥 UpdateData (categoryIds):', updateData.categoryIds);

    // Did an address field ACTUALLY change? Compare the incoming value to the
    // current record BEFORE updating — forms resend the address on every save,
    // so checking "field present" would re-geocode unchanged addresses and waste
    // (rate-limited) geocoder calls.
    const addressChanged = ['address', 'addressComplement', 'city', 'country', 'zipCode'].some(
      (k) => normalizedData[k] !== undefined && String(normalizedData[k] ?? '') !== String((record as any)[k] ?? ''),
    );
    const coordsProvided = normalizedData.latitude != null || normalizedData.longitude != null;

    record = await record.update(
      updateData,
      {
        transaction,
      },
    );

    // Keep coordinates in sync only when the address truly changed and no explicit
    // coords were supplied. Best-effort, cached + rate-limited in geocode.ts.
    if (addressChanged && !coordsProvided) {
      try {
        const { geocodeAddress } = require('../../lib/geocode');
        const full = [record.address, record.city, record.country].filter(Boolean).join(', ');
        const pt = await geocodeAddress(full);
        if (pt) await record.update({ latitude: pt.latitude, longitude: pt.longitude }, { transaction });
      } catch (e) { /* best-effort geocode */ }
    }


    if (data.logoUrl !== undefined) {
      await FileRepository.replaceRelationFiles(
        {
          belongsTo: options.database.clientAccount.getTableName(),
          belongsToColumn: 'logoUrl',
          belongsToId: id,
        },
        data.logoUrl,
        options,
      );
    }

    if (data.placePictureUrl !== undefined) {
      await FileRepository.replaceRelationFiles(
        {
          belongsTo: options.database.clientAccount.getTableName(),
          belongsToColumn: 'placePictureUrl',
          belongsToId: id,
        },
        data.placePictureUrl,
        options,
      );
    }

    await this._createAuditLog(
      AuditLogRepository.UPDATE,
      record,
      data,
      options,
    );

    // Reload the record to get fresh data from the database
    await record.reload({ transaction });

    return this._fillWithRelationsAndFiles(record, options);
  }

  static async destroy(id, options: IRepositoryOptions) {
    const transaction = SequelizeRepository.getTransaction(
      options,
    );

    const currentTenant = SequelizeRepository.getCurrentTenant(
      options,
    );

    let record = await options.database.clientAccount.findOne(
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

    // Prevent deleting a client account if it has related businessInfo records
    const { sequelize } = options.database;
    const [results] = await sequelize.query(
      `SELECT COUNT(*) as count
       FROM businessInfos
       WHERE tenantId = :tenantId
       AND deletedAt IS NULL
       AND clientAccountId = :clientAccountId`,
      {
        replacements: {
          tenantId: currentTenant.id,
          clientAccountId: id,
        },
        transaction,
      },
    );

    const inUseCount = (results as any)[0]?.count || 0;
    if (inUseCount > 0) {
      const err: any = new Error(`No se puede eliminar: existen ${inUseCount} sitio(s) asociados`);
      err.code = 400;
      throw err;
    }

    await record.destroy({
      transaction,
    });

    await this._createAuditLog(
      AuditLogRepository.DELETE,
      record,
      record,
      options,
    );
  }

  static async findById(id, options: IRepositoryOptions) {
    const transaction = SequelizeRepository.getTransaction(
      options,
    );

    const include = [];

    const currentTenant = SequelizeRepository.getCurrentTenant(
      options,
    );

    // If caller requested to bypass permission validation, return the record
    // directly (used right after create to avoid read ACL race conditions).
    if (options && (options as any).bypassPermissionValidation) {
      const record = await options.database.clientAccount.findOne({
        where: { id, tenantId: currentTenant.id },
        include,
        transaction,
      });

      if (!record) {
        throw new Error404();
      }

      return this._fillWithRelationsAndFiles(record, options);
    }

    // Enforce ACL: if current user is not admin, ensure the client is assigned to them
    const currentUser = SequelizeRepository.getCurrentUser(options);
    let isAdmin = false;
    try {
      if (currentUser && currentUser.tenants) {
        const tenantUserRec = currentUser.tenants.find((t) => t.tenant.id === currentTenant.id && t.status === 'active');
        if (tenantUserRec) {
          let roles: any = [];
          if (Array.isArray(tenantUserRec.roles)) roles = tenantUserRec.roles;
          else if (typeof tenantUserRec.roles === 'string') {
            try { roles = JSON.parse(tenantUserRec.roles); } catch (e) { roles = []; }
          }
          isAdmin = roles.includes(Roles.values.admin);
        }
      }
    } catch (e) {
      isAdmin = false;
    }

    if (!isAdmin) {
      // fetch tenantUser to get assignedClients
      const tenantUser = await options.database.tenantUser.findOne({
        where: { tenantId: currentTenant.id, userId: currentUser.id },
        include: [{ model: options.database.clientAccount, as: 'assignedClients', attributes: ['id'] }],
        transaction,
      });

      const allowedIds = (tenantUser && tenantUser.assignedClients && tenantUser.assignedClients.map((c) => c.id)) || [];
      if (!allowedIds.length) {
        throw new Error404();
      }

      if (!allowedIds.includes(id)) {
        throw new Error404();
      }

      const record = await options.database.clientAccount.findOne({
        where: {
          id,
          tenantId: currentTenant.id,
        },
        include,
        transaction,
      });

      if (!record) {
        throw new Error404();
      }

      return this._fillWithRelationsAndFiles(record, options);
    }

    const record = await options.database.clientAccount.findOne(
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
      throw new Error404();
    }

    return this._fillWithRelationsAndFiles(record, options);
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

    const records = await options.database.clientAccount.findAll(
      {
        attributes: ['id'],
        where,
        transaction: SequelizeRepository.getTransaction(options),
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

    return options.database.clientAccount.count(
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
    let include = [];

    whereAnd.push({
      tenantId: tenant.id,
    });

    if (filter) {
      if (filter.id) {
        whereAnd.push({
          ['id']: SequelizeFilterUtils.uuid(filter.id),
        });
      }

      if (filter.name) {
        whereAnd.push({
          [Op.or]: [
            SequelizeFilterUtils.ilikeIncludes(
              'clientAccount',
              'name',
              filter.name,
            ),
            SequelizeFilterUtils.ilikeIncludes(
              'clientAccount',
              'lastName',
              filter.name,
            ),
          ],
        });
      }

      if (filter.address) {
        whereAnd.push(
          SequelizeFilterUtils.ilikeIncludes(
            'clientAccount',
            'address',
            filter.address,
          ),
        );
      }

      if (filter.phoneNumber) {
        whereAnd.push(
          SequelizeFilterUtils.ilikeIncludes(
            'clientAccount',
            'phoneNumber',
            filter.phoneNumber,
          ),
        );
      }

      if (filter.faxNumber) {
        whereAnd.push(
          SequelizeFilterUtils.ilikeIncludes(
            'clientAccount',
            'faxNumber',
            filter.faxNumber,
          ),
        );
      }

      if (filter.email) {
        whereAnd.push(
          SequelizeFilterUtils.ilikeIncludes(
            'clientAccount',
            'email',
            filter.email,
          ),
        );
      }

      if (filter.website) {
        whereAnd.push(
          SequelizeFilterUtils.ilikeIncludes(
            'clientAccount',
            'website',
            filter.website,
          ),
        );
      }

      // Filter by active (supports true/false and 1/0 and strings)
      if (filter.active !== undefined && filter.active !== null && filter.active !== '') {
        const raw = filter.active;
        let activeBool: boolean;
        if (typeof raw === 'boolean') {
          activeBool = raw;
        } else if (typeof raw === 'number') {
          activeBool = raw === 1;
        } else if (typeof raw === 'string') {
          const val = raw.toLowerCase();
          activeBool = val === '1' || val === 'true';
        } else {
          // Fallback: treat truthy as true
          activeBool = !!raw;
        }
        whereAnd.push({ ['active']: activeBool });
      }

      if (filter.city) {
        whereAnd.push(
          SequelizeFilterUtils.ilikeIncludes(
            'clientAccount',
            'city',
            filter.city,
          ),
        );
      }

      if (filter.country) {
        whereAnd.push(
          SequelizeFilterUtils.ilikeIncludes(
            'clientAccount',
            'country',
            filter.country,
          ),
        );
      }

      if (filter.categoryIds) {
        console.log('🔍 Filtro de categoryIds recibido:', filter.categoryIds);
        console.log('🔍 Tipo de filtro:', typeof filter.categoryIds);
        
        // Filter by category using JSON_CONTAINS for MySQL
        whereAnd.push(
          Sequelize.literal(
            `JSON_CONTAINS(categoryIds, '"${filter.categoryIds}"')`
          )
        );
        console.log('✅ Filtrando por categoryIds en JSON field:', filter.categoryIds);
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
    // ACL: if current user is not admin, restrict list to assigned clients
    try {
      const currentUser = SequelizeRepository.getCurrentUser(options);
      let isAdmin = false;
      if (currentUser && currentUser.tenants) {
        const tenantUserRec = currentUser.tenants.find((t) => t.tenant.id === tenant.id && t.status === 'active');
        if (tenantUserRec) {
          let roles: any = [];
          if (Array.isArray(tenantUserRec.roles)) roles = tenantUserRec.roles;
          else if (typeof tenantUserRec.roles === 'string') {
            try { roles = JSON.parse(tenantUserRec.roles); } catch (e) { roles = []; }
          }
          isAdmin = roles.includes(Roles.values.admin);
        }
      }

      if (!isAdmin) {
        const tenantUser = await options.database.tenantUser.findOne({
          where: { tenantId: tenant.id, userId: currentUser.id },
          include: [{ model: options.database.clientAccount, as: 'assignedClients', attributes: ['id'] }],
          transaction: SequelizeRepository.getTransaction(options),
        });

        const allowedIds = (tenantUser && tenantUser.assignedClients && tenantUser.assignedClients.map((c) => c.id)) || [];
        if (!allowedIds.length) {
          return { rows: [], count: 0 };
        }

        where[Op.and].push({ id: { [Op.in]: allowedIds } });
      }
    } catch (e) {
      // If ACL check fails, fall back to default behavior
    }
    let {
      rows,
      count,
    } = await options.database.clientAccount.findAndCountAll({
      // Explicit attribute whitelist — never SELECT *. The clients list (CRM
      // table + mobile cards + the visitor/import client selects) renders
      // name/commercialName/lastName/email/phoneNumber/address/active/
      // onboardingStatus; clientService also reads zipCode/addressComplement and
      // checkCategoryUsage reads categoryIds. We keep only those + cheap scalars,
      // and DROP the logoUrl/placePictureUrl file relations + the category
      // findAll (none are rendered in any list surface — they are detail-only).
      attributes: LIST_ATTRIBUTES,
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
    });
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

    // ACL: if not admin, restrict autocomplete to assigned clients
    try {
      const currentUser = SequelizeRepository.getCurrentUser(options);
      let isAdmin = false;
      if (currentUser && currentUser.tenants) {
        const tenantUserRec = currentUser.tenants.find((t) => t.tenant.id === tenant.id && t.status === 'active');
        if (tenantUserRec) {
          let roles: any = [];
          if (Array.isArray(tenantUserRec.roles)) roles = tenantUserRec.roles;
          else if (typeof tenantUserRec.roles === 'string') {
            try { roles = JSON.parse(tenantUserRec.roles); } catch (e) { roles = []; }
          }
          // "Sees all clients" is not just the literal admin role — every OFFICE /
          // management role does (they run the CRM, message clients, dispatch,
          // etc.). Restricting to the assigned-clients subset is only for
          // genuinely client-scoped reps. The old admin-only check left owners/
          // ops-managers/dispatchers with an EMPTY client picker in the messenger.
          const SEES_ALL_CLIENTS = [
            Roles.values.superadmin, Roles.values.admin, Roles.values.operationsManager,
            Roles.values.administrativeSupervisor, Roles.values.administrativeAssistant,
            Roles.values.dispatcher,
          ].filter(Boolean);
          isAdmin = roles.some((r: any) => SEES_ALL_CLIENTS.includes(r));
        }
      }

      if (!isAdmin) {
        const tenantUser = await options.database.tenantUser.findOne({
          where: { tenantId: tenant.id, userId: currentUser.id },
          include: [{ model: options.database.clientAccount, as: 'assignedClients', attributes: ['id'] }],
          transaction: SequelizeRepository.getTransaction(options),
        });

        const allowedIds = (tenantUser && tenantUser.assignedClients && tenantUser.assignedClients.map((c) => c.id)) || [];
        // A user who is NOT an office role AND has no explicit client assignments
        // is not a scoped rep — don't hide every client (that was the bug). Only
        // restrict when they DO have assignments.
        if (allowedIds.length) {
          whereAnd.push({ id: { [Op.in]: allowedIds } });
        }
      }
    } catch (e) {
      // ignore and continue
    }

    if (query) {
      whereAnd.push({
        [Op.or]: [
          { ['id']: SequelizeFilterUtils.uuid(query) },
          {
            [Op.and]: SequelizeFilterUtils.ilikeIncludes(
              'clientAccount',
              'name',
              query,
            ),
          },
        ],
      });
    }

    const where = { [Op.and]: whereAnd };

    const records = await options.database.clientAccount.findAll(
      {
        attributes: ['id', 'name'],
        where,
        limit: limit ? Number(limit) : undefined,
        order: [['name', 'ASC']],
      },
    );

    return records.map((record) => ({
      id: record.id,
      label: record.name,
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
      };
    }

    await AuditLogRepository.log(
      {
        entityName: 'clientAccount',
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
   * LEAN enricher for the LIST path. The clients list renders only scalar
   * fields (name/commercialName/lastName/email/phoneNumber/address/active/
   * onboardingStatus) + uses categoryIds in checkCategoryUsage — it renders NO
   * logo/place thumbnails and NO resolved `categories` array. The old per-row
   * `_fillWithRelationsAndFiles` ran a category.findAll + getLogoUrl (file query
   * + S3 sign) + getPlacePictureUrl (file query + sign) PER ROW — ~3 queries +
   * 2 signings per row over a table the CRM fetches whole. This does ZERO extra
   * queries: just maps each row to plain and keeps the file keys present (empty)
   * so the response shape is stable. The full detail enrichment (categories +
   * signed logoUrl/placePictureUrl) stays in findById → _fillWithRelationsAndFiles.
   */
  static async _fillForList(rows, options: IRepositoryOptions) {
    if (!rows || !rows.length) return rows;

    const outputs = rows.map((record) => {
      const output: any = record.get({ plain: true });
      output.categories = output.categories || [];
      return output;
    });
    // The clients list renders the logo (and place picture) — sign both for ALL
    // rows in ONE file query each (batched), not the old per-row N+1.
    const table = options.database.clientAccount.getTableName();
    await batchSignFiles(options.database, outputs, table, 'logoUrl');
    await batchSignFiles(options.database, outputs, table, 'placePictureUrl');
    return outputs;
  }

  static async _fillWithRelationsAndFiles(record, options: IRepositoryOptions) {
    if (!record) {
      return record;
    }

    const output = record.get({ plain: true });
    const transaction = SequelizeRepository.getTransaction(options);

    // Load categories from categoryIds JSON array
    if (output.categoryIds && Array.isArray(output.categoryIds) && output.categoryIds.length > 0) {
      const categories = await options.database.category.findAll({
        where: {
          id: {
            [Op.in]: output.categoryIds,
          },
        },
        transaction,
      });
      output.categories = categories.map(cat => cat.get({ plain: true }));
    } else {
      output.categories = [];
    }

    output.logoUrl = await FileRepository.fillDownloadUrl(
      await record.getLogoUrl({ transaction }),
    );

    output.placePictureUrl = await FileRepository.fillDownloadUrl(
      await record.getPlacePictureUrl({ transaction }),
    );

    return output;
  }
}

export default ClientAccountRepository;
