import SequelizeRepository from '../../database/repositories/sequelizeRepository';
import AuditLogRepository from '../../database/repositories/auditLogRepository';
import lodash from 'lodash';
import SequelizeFilterUtils from '../../database/utils/sequelizeFilterUtils';
import Error404 from '../../errors/Error404';
import Sequelize from 'sequelize';import FileRepository from './fileRepository';
import { IRepositoryOptions } from './IRepositoryOptions';

const Op = Sequelize.Op;

class BusinessInfoRepository {

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

    const record = await options.database.businessInfo.create(
      {
        ...lodash.pick(data, [
          'companyName',
          'description',
          'contactPhone',
          'contactEmail',
          'address',
          'latitud',
          'longitud',
          'categoryIds',
          'clientAccountId',
          'secondAddress',
          'country',
          'city',
          'postalCode',
          'active',
          'importHash',
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
        belongsTo: options.database.businessInfo.getTableName(),
        belongsToColumn: 'logo',
        belongsToId: record.id,
      },
      data.logo,
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

    let record = await options.database.businessInfo.findOne(      
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

    record = await record.update(
      {
        ...lodash.pick(data, [
          'companyName',
          'description',
          'contactPhone',
          'contactEmail',
          'address',
          'latitud',
          'longitud',
          'categoryIds',
          'clientAccountId',
          'secondAddress',
          'country',
          'city',
          'postalCode',
          'active',
          'importHash',
        ]),

        updatedById: currentUser.id,
      },
      {
        transaction,
      },
    );



    await FileRepository.replaceRelationFiles(
      {
        belongsTo: options.database.businessInfo.getTableName(),
        belongsToColumn: 'logo',
        belongsToId: record.id,
      },
      data.logo,
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

    let record = await options.database.businessInfo.findOne(
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

    // Force physical deletion to remove the row from the database
    // (model is paranoid; default destroy() only sets `deletedAt`).
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

  static async findById(id, options: IRepositoryOptions) {
    const transaction = SequelizeRepository.getTransaction(
      options,
    );

    const include = [
      {
        model: options.database.clientAccount,
        as: 'clientAccount',
      },
    ];

    const currentTenant = SequelizeRepository.getCurrentTenant(
      options,
    );

    const record = await options.database.businessInfo.findOne(
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

    const records = await options.database.businessInfo.findAll(
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

    return options.database.businessInfo.count(
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
        model: options.database.clientAccount,
        as: 'clientAccount',
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

      // Support multiple possible incoming filter keys for name (legacy compat)
      // Accept common aliases from frontend search inputs: `companyName`, `name`,
      // `postSiteName`, `q`, `query`, `search` — always search on `companyName`.
      const nameFilter =
        filter.companyName ||
        filter.name ||
        filter.postSiteName ||
        filter.q ||
        filter.query ||
        filter.search;
      if (nameFilter) {
        whereAnd.push(
          SequelizeFilterUtils.ilikeIncludes(
            'businessInfo',
            'companyName',
            nameFilter,
          ),
        );
      }

      if (filter.description) {
        whereAnd.push(
          SequelizeFilterUtils.ilikeIncludes(
            'businessInfo',
            'description',
            filter.description,
          ),
        );
      }

      if (filter.contactPhone) {
        whereAnd.push(
          SequelizeFilterUtils.ilikeIncludes(
            'businessInfo',
            'contactPhone',
            filter.contactPhone,
          ),
        );
      }

      if (filter.contactEmail) {
        whereAnd.push(
          SequelizeFilterUtils.ilikeIncludes(
            'businessInfo',
            'contactEmail',
            filter.contactEmail,
          ),
        );
      }

      if (filter.address) {
        whereAnd.push(
          SequelizeFilterUtils.ilikeIncludes(
            'businessInfo',
            'address',
            filter.address,
          ),
        );
      }

      if (filter.secondAddress) {
        whereAnd.push(
          SequelizeFilterUtils.ilikeIncludes(
            'businessInfo',
            'secondAddress',
            filter.secondAddress,
          ),
        );
      }

      if (filter.city) {
        whereAnd.push(
          SequelizeFilterUtils.ilikeIncludes(
            'businessInfo',
            'city',
            filter.city,
          ),
        );
      }

      if (filter.country) {
        whereAnd.push(
          SequelizeFilterUtils.ilikeIncludes(
            'businessInfo',
            'country',
            filter.country,
          ),
        );
      }

      if (filter.postalCode) {
        whereAnd.push(
          SequelizeFilterUtils.ilikeIncludes(
            'businessInfo',
            'postalCode',
            filter.postalCode,
          ),
        );
      }

      if (filter.categoryIds) {
        // Qualify column with main table name to avoid ambiguity when joins exist
        // Use model alias `businessInfo` (Sequelize uses model name as alias)
        const mainAlias = 'businessInfo';

        // Support filtering by single category id or array of category ids.
        if (Array.isArray(filter.categoryIds)) {
          whereAnd.push({
            [Op.or]: filter.categoryIds.map((id) =>
              Sequelize.literal(
                `JSON_CONTAINS(${mainAlias}.categoryIds, '${JSON.stringify(id)}')`,
              ),
            ),
          });
        } else {
          whereAnd.push(
            Sequelize.literal(
              `JSON_CONTAINS(${mainAlias}.categoryIds, '${JSON.stringify(
                filter.categoryIds,
              )}')`,
            ),
          );
        }
      }

      // Filter by active. Accepts true/false, 1/0, string values.
      // Special case: treat 'all'/'todos'/'both' as "no filter" (show both active and archived).
      if (filter.active !== undefined && filter.active !== null && filter.active !== '') {
        const raw = filter.active;

        // If frontend explicitly requests 'all' variants, skip adding any active filter
        if (typeof raw === 'string') {
          const val = raw.toLowerCase();
          if (['all', 'todos', 'both', 'any'].includes(val)) {
            // do not add active filter => show both active and archived
          } else {
            let activeBool: boolean;
            if (val === '1' || val === 'true') {
              activeBool = true;
            } else if (val === '0' || val === 'false') {
              activeBool = false;
            } else {
              // Fallback: try to coerce
              activeBool = !!raw;
            }
            whereAnd.push({ active: activeBool });
          }
        } else if (typeof raw === 'boolean') {
          whereAnd.push({ active: raw });
        } else if (typeof raw === 'number') {
          whereAnd.push({ active: raw === 1 });
        } else {
          whereAnd.push({ active: !!raw });
        }
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
    } = await options.database.businessInfo.findAndCountAll({
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
              'businessInfo',
              'companyName',
              query,
            ),
          },
        ],
      });
    }

    const where = { [Op.and]: whereAnd };

    const records = await options.database.businessInfo.findAll(
      {
        attributes: ['id', 'companyName'],
        where,
        limit: limit ? Number(limit) : undefined,
        order: [['companyName', 'ASC']],
      },
    );

    return records.map((record) => ({
      id: record.id,
      label: record.companyName,
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
        logo: data.logo,
      };
    }

    await AuditLogRepository.log(
      {
        entityName: 'businessInfo',
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

    const transaction = SequelizeRepository.getTransaction(
      options,
    );

    output.logo = await FileRepository.fillDownloadUrl(
      await record.getLogo({
        transaction,
      }),
    );

    // Attach clientAccount object and a combined name field
    try {
      const client = await record.getClientAccount({ transaction });
      output.clientAccount = client ? client.get({ plain: true }) : null;
      output.clientAccountName = output.clientAccount
        ? `${output.clientAccount.name || ''} ${output.clientAccount.lastName || ''}`.trim()
        : null;
    } catch (e) {
      output.clientAccount = null;
      output.clientAccountName = null;
    }

    return output;
  }
}

export default BusinessInfoRepository;
