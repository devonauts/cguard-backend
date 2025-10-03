import SequelizeRepository from '../../database/repositories/sequelizeRepository';
import AuditLogRepository from '../../database/repositories/auditLogRepository';
import lodash from 'lodash';
import SequelizeFilterUtils from '../../database/utils/sequelizeFilterUtils';
import Error404 from '../../errors/Error404';
import Sequelize from 'sequelize';
import { IRepositoryOptions } from './IRepositoryOptions';

const Op = Sequelize.Op;

class InventoryRepository {

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

    const record = await options.database.inventory.create(
      {
        ...lodash.pick(data, [
          'belongsToStation',
          'radio',
          'radioType',
          'radioSerialNumber',
          'gun',
          'gunType',
          'gunSerialNumber',
          'armor',
          'armorType',
          'armorSerialNumber',
          'tolete',
          'pito',
          'linterna',
          'vitacora',
          'cintoCompleto',
          'ponchoDeAguas',
          'detectorDeMetales',
          'caseta',
          'observations',
          'transportation',          
          'importHash',
        ]),
        belongsToId: data.belongsTo || null,
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

    let record = await options.database.inventory.findOne(      
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
          'belongsToStation',
          'radio',
          'radioType',
          'radioSerialNumber',
          'gun',
          'gunType',
          'gunSerialNumber',
          'armor',
          'armorType',
          'armorSerialNumber',
          'tolete',
          'pito',
          'linterna',
          'vitacora',
          'cintoCompleto',
          'ponchoDeAguas',
          'detectorDeMetales',
          'caseta',
          'observations',
          'transportation',          
          'importHash',
        ]),
        belongsToId: data.belongsTo || null,
        updatedById: currentUser.id,
      },
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

    return this.findById(record.id, options);
  }

  static async destroy(id, options: IRepositoryOptions) {
    const transaction = SequelizeRepository.getTransaction(
      options,
    );

    const currentTenant = SequelizeRepository.getCurrentTenant(
      options,
    );

    let record = await options.database.inventory.findOne(
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
        model: options.database.station,
        as: 'belongsTo',
      },
    ];

    const currentTenant = SequelizeRepository.getCurrentTenant(
      options,
    );

    const record = await options.database.inventory.findOne(
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

    const records = await options.database.inventory.findAll(
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

    return options.database.inventory.count(
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
        model: options.database.station,
        as: 'belongsTo',
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

      if (filter.belongsTo) {
        whereAnd.push({
          ['belongsToId']: SequelizeFilterUtils.uuid(
            filter.belongsTo,
          ),
        });
      }

      if (filter.belongsToStation) {
        whereAnd.push(
          SequelizeFilterUtils.ilikeIncludes(
            'inventory',
            'belongsToStation',
            filter.belongsToStation,
          ),
        );
      }

      if (
        filter.radio === true ||
        filter.radio === 'true' ||
        filter.radio === false ||
        filter.radio === 'false'
      ) {
        whereAnd.push({
          radio:
            filter.radio === true ||
            filter.radio === 'true',
        });
      }

      if (filter.radioType) {
        whereAnd.push(
          SequelizeFilterUtils.ilikeIncludes(
            'inventory',
            'radioType',
            filter.radioType,
          ),
        );
      }

      if (filter.radioSerialNumber) {
        whereAnd.push(
          SequelizeFilterUtils.ilikeIncludes(
            'inventory',
            'radioSerialNumber',
            filter.radioSerialNumber,
          ),
        );
      }

      if (
        filter.gun === true ||
        filter.gun === 'true' ||
        filter.gun === false ||
        filter.gun === 'false'
      ) {
        whereAnd.push({
          gun:
            filter.gun === true ||
            filter.gun === 'true',
        });
      }

      if (filter.gunType) {
        whereAnd.push({
          gunType: filter.gunType,
        });
      }

      if (filter.gunSerialNumber) {
        whereAnd.push(
          SequelizeFilterUtils.ilikeIncludes(
            'inventory',
            'gunSerialNumber',
            filter.gunSerialNumber,
          ),
        );
      }

      if (
        filter.armor === true ||
        filter.armor === 'true' ||
        filter.armor === false ||
        filter.armor === 'false'
      ) {
        whereAnd.push({
          armor:
            filter.armor === true ||
            filter.armor === 'true',
        });
      }

      if (filter.armorType) {
        whereAnd.push(
          SequelizeFilterUtils.ilikeIncludes(
            'inventory',
            'armorType',
            filter.armorType,
          ),
        );
      }

      if (filter.armorSerialNumber) {
        whereAnd.push(
          SequelizeFilterUtils.ilikeIncludes(
            'inventory',
            'armorSerialNumber',
            filter.armorSerialNumber,
          ),
        );
      }

      if (
        filter.tolete === true ||
        filter.tolete === 'true' ||
        filter.tolete === false ||
        filter.tolete === 'false'
      ) {
        whereAnd.push({
          tolete:
            filter.tolete === true ||
            filter.tolete === 'true',
        });
      }

      if (
        filter.pito === true ||
        filter.pito === 'true' ||
        filter.pito === false ||
        filter.pito === 'false'
      ) {
        whereAnd.push({
          pito:
            filter.pito === true ||
            filter.pito === 'true',
        });
      }

      if (
        filter.linterna === true ||
        filter.linterna === 'true' ||
        filter.linterna === false ||
        filter.linterna === 'false'
      ) {
        whereAnd.push({
          linterna:
            filter.linterna === true ||
            filter.linterna === 'true',
        });
      }

      if (
        filter.vitacora === true ||
        filter.vitacora === 'true' ||
        filter.vitacora === false ||
        filter.vitacora === 'false'
      ) {
        whereAnd.push({
          vitacora:
            filter.vitacora === true ||
            filter.vitacora === 'true',
        });
      }

      if (
        filter.cintoCompleto === true ||
        filter.cintoCompleto === 'true' ||
        filter.cintoCompleto === false ||
        filter.cintoCompleto === 'false'
      ) {
        whereAnd.push({
          cintoCompleto:
            filter.cintoCompleto === true ||
            filter.cintoCompleto === 'true',
        });
      }

      if (
        filter.ponchoDeAguas === true ||
        filter.ponchoDeAguas === 'true' ||
        filter.ponchoDeAguas === false ||
        filter.ponchoDeAguas === 'false'
      ) {
        whereAnd.push({
          ponchoDeAguas:
            filter.ponchoDeAguas === true ||
            filter.ponchoDeAguas === 'true',
        });
      }

      if (
        filter.detectorDeMetales === true ||
        filter.detectorDeMetales === 'true' ||
        filter.detectorDeMetales === false ||
        filter.detectorDeMetales === 'false'
      ) {
        whereAnd.push({
          detectorDeMetales:
            filter.detectorDeMetales === true ||
            filter.detectorDeMetales === 'true',
        });
      }

      if (
        filter.caseta === true ||
        filter.caseta === 'true' ||
        filter.caseta === false ||
        filter.caseta === 'false'
      ) {
        whereAnd.push({
          caseta:
            filter.caseta === true ||
            filter.caseta === 'true',
        });
      }

      if (filter.observations) {
        whereAnd.push(
          SequelizeFilterUtils.ilikeIncludes(
            'inventory',
            'observations',
            filter.observations,
          ),
        );
      }

      if (filter.transportation) {
        whereAnd.push({
          transportation: filter.transportation,
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
    } = await options.database.inventory.findAndCountAll({
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
              'inventory',
              'belongsToStation',
              query,
            ),
          },
        ],
      });
    }

    const where = { [Op.and]: whereAnd };

    const records = await options.database.inventory.findAll(
      {
        attributes: ['id', 'belongsToStation'],
        where,
        limit: limit ? Number(limit) : undefined,
        order: [['belongsToStation', 'ASC']],
      },
    );

    return records.map((record) => ({
      id: record.id,
      label: record.belongsToStation,
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
        entityName: 'inventory',
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



    return output;
  }
}

export default InventoryRepository;
