import SequelizeRepository from '../../database/repositories/sequelizeRepository';
import AuditLogRepository from '../../database/repositories/auditLogRepository';
import lodash from 'lodash';
import SequelizeFilterUtils from '../../database/utils/sequelizeFilterUtils';
import Error404 from '../../errors/Error404';
import Sequelize from 'sequelize';
import { IRepositoryOptions } from './IRepositoryOptions';

const Op = Sequelize.Op;

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

    const record = await options.database.clientAccount.create(
      {
        ...lodash.pick(data, [
          'name',
          'lastName',
          'email',
          'phoneNumber',
          'address',
          'addressComplement',
          'zipCode',
          'city',
          'country',
          'useSameAddressForBilling',
          'faxNumber',
          'website',
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

    const updateData = {
      ...lodash.pick(data, [
        'name',
        'lastName',
        'email',
        'phoneNumber',
        'address',
        'addressComplement',
        'zipCode',
        'city',
        'country',
        'useSameAddressForBilling',
        'faxNumber',
        'website',
        'latitude',
        'longitude',
        'importHash',
        'categoryIds',
        'active',
      ]),
      updatedById: currentUser.id,
    };

    console.log('📥 UpdateData a guardar:', updateData);
    console.log('📥 UpdateData (active):', updateData.active);
    console.log('📥 UpdateData (categoryIds):', updateData.categoryIds);

    record = await record.update(
      updateData,
      {
        transaction,
      },
    );

    console.log('✅ Registro actualizado en BD:', record.toJSON());
    console.log('✅ Registro (active):', record.active);


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
    console.log('🔍 [ClientAccountRepo] incoming filter:', JSON.stringify(filter));
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
        console.log('🔍 [ClientAccountRepo] searching name/lastName with:', filter.name);
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
    console.log('🔍 [ClientAccountRepo] final where:', JSON.stringify(where, null, 2));

    let {
      rows,
      count,
    } = await options.database.clientAccount.findAndCountAll({
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
    console.log('🔍 [ClientAccountRepo] found rows:', rows?.length, 'count:', count);
    console.log('🔍 [ClientAccountRepo] raw results:', rows?.map(r => ({ id: r.id, name: r.name, email: r.email, tenantId: r.tenantId })));

    rows = await this._fillWithRelationsAndFilesForRows(
      rows,
      options,
    );

    return { rows, count };
  }

  static async findAllAutocomplete(query, limit, options: IRepositoryOptions) {
    const tenant = SequelizeRepository.getCurrentTenant(
      options,
    );

    let whereAnd: Array<any> = [{
      tenantId: tenant.id,
    }];

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

  static async _fillWithRelationsAndFiles(record, options: IRepositoryOptions) {
    if (!record) {
      return record;
    }

    const output = record.get({ plain: true });

    // Load categories from categoryIds JSON array
    if (output.categoryIds && Array.isArray(output.categoryIds) && output.categoryIds.length > 0) {
      const transaction = SequelizeRepository.getTransaction(options);
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

    return output;
  }
}

export default ClientAccountRepository;
