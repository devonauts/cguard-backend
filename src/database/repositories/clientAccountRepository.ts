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
          'importHash',
          'categoryId',
        ]),
        // categoryId: data.categoryId || null,
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
        'importHash',
        'categoryId',
      ]),
      // categoryId: data.categoryId || null,
      updatedById: currentUser.id,
    };


    record = await record.update(
      updateData,
      {
        transaction,
      },
    );


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

    const include = [
      {
        model: options.database.category,
        as: 'category',
        required: false,
        attributes: ['id', 'name'],
      },
    ];

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
    const tenant = SequelizeRepository.getCurrentTenant(
      options,
    );

    let whereAnd: Array<any> = [];
    let include = [
      {
        model: options.database.category,
        as: 'category',
        required: false,
        attributes: ['id', 'name'],
      },
    ];

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

      if (filter.category) {
        console.log('🔍 Filtro de categoría recibido:', filter.category);
        console.log('🔍 Tipo de filtro:', typeof filter.category);
        
        // Simplemente filtrar por categoryId directamente
        whereAnd.push({
          ['categoryId']: SequelizeFilterUtils.uuid(filter.category),
        });
        console.log('✅ Filtrando por categoryId:', filter.category);
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

    return output;
  }
}

export default ClientAccountRepository;
