import SequelizeRepository from '../../database/repositories/sequelizeRepository';
import AuditLogRepository from '../../database/repositories/auditLogRepository';
import lodash from 'lodash';
import SequelizeFilterUtils from '../../database/utils/sequelizeFilterUtils';
import Error404 from '../../errors/Error404';
import Sequelize from 'sequelize';import UserRepository from './userRepository';
import FileRepository from './fileRepository';
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
          'contractDate',
          'rucNumber',
          'commercialName',
          'address',
          'phoneNumber',
          'faxNumber',
          'email',          
          'importHash',
        ]),
        representanteId: data.representante || null,
        tenantId: tenant.id,
        createdById: currentUser.id,
        updatedById: currentUser.id,
      },
      {
        transaction,
      },
    );

    await record.setPurchasedServices(data.purchasedServices || [], {
      transaction,
    });
    await record.setStations(data.stations || [], {
      transaction,
    });
    await record.setBillingInvoices(data.billingInvoices || [], {
      transaction,
    });
    await record.setPushNotifications(data.pushNotifications || [], {
      transaction,
    });    
  
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

    record = await record.update(
      {
        ...lodash.pick(data, [
          'contractDate',
          'rucNumber',
          'commercialName',
          'address',
          'phoneNumber',
          'faxNumber',
          'email',          
          'importHash',
        ]),
        representanteId: data.representante || null,
        updatedById: currentUser.id,
      },
      {
        transaction,
      },
    );

    await record.setPurchasedServices(data.purchasedServices || [], {
      transaction,
    });
    await record.setStations(data.stations || [], {
      transaction,
    });
    await record.setBillingInvoices(data.billingInvoices || [], {
      transaction,
    });
    await record.setPushNotifications(data.pushNotifications || [], {
      transaction,
    });

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
        model: options.database.user,
        as: 'representante',
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
        model: options.database.user,
        as: 'representante',
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

      if (filter.contractDateRange) {
        const [start, end] = filter.contractDateRange;

        if (start !== undefined && start !== null && start !== '') {
          whereAnd.push({
            contractDate: {
              [Op.gte]: start,
            },
          });
        }

        if (end !== undefined && end !== null && end !== '') {
          whereAnd.push({
            contractDate: {
              [Op.lte]: end,
            },
          });
        }
      }

      if (filter.rucNumber) {
        whereAnd.push(
          SequelizeFilterUtils.ilikeIncludes(
            'clientAccount',
            'rucNumber',
            filter.rucNumber,
          ),
        );
      }

      if (filter.commercialName) {
        whereAnd.push(
          SequelizeFilterUtils.ilikeIncludes(
            'clientAccount',
            'commercialName',
            filter.commercialName,
          ),
        );
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

      if (filter.representante) {
        whereAnd.push({
          ['representanteId']: SequelizeFilterUtils.uuid(
            filter.representante,
          ),
        });
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
              'commercialName',
              query,
            ),
          },
        ],
      });
    }

    const where = { [Op.and]: whereAnd };

    const records = await options.database.clientAccount.findAll(
      {
        attributes: ['id', 'commercialName'],
        where,
        limit: limit ? Number(limit) : undefined,
        order: [['commercialName', 'ASC']],
      },
    );

    return records.map((record) => ({
      id: record.id,
      label: record.commercialName,
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
        logoUrl: data.logoUrl,
        placePictureUrl: data.placePictureUrl,
        purchasedServicesIds: data.purchasedServices,
        stationsIds: data.stations,
        billingInvoicesIds: data.billingInvoices,
        pushNotificationsIds: data.pushNotifications,
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

    const transaction = SequelizeRepository.getTransaction(
      options,
    );

    output.logoUrl = await FileRepository.fillDownloadUrl(
      await record.getLogoUrl({
        transaction,
      }),
    );

    output.placePictureUrl = await FileRepository.fillDownloadUrl(
      await record.getPlacePictureUrl({
        transaction,
      }),
    );

    output.representante = UserRepository.cleanupForRelationships(output.representante);

    output.purchasedServices = await record.getPurchasedServices({
      transaction,
    });

    output.stations = await record.getStations({
      transaction,
    });

    output.billingInvoices = await record.getBillingInvoices({
      transaction,
    });

    output.pushNotifications = await record.getPushNotifications({
      transaction,
    });

    return output;
  }
}

export default ClientAccountRepository;
