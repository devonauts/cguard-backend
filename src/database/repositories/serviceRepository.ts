import SequelizeRepository from '../../database/repositories/sequelizeRepository';
import AuditLogRepository from '../../database/repositories/auditLogRepository';
import lodash from 'lodash';
import SequelizeFilterUtils from '../../database/utils/sequelizeFilterUtils';
import Error404 from '../../errors/Error404';
import Error400 from '../../errors/Error400';
import Sequelize from 'sequelize';import FileRepository from './fileRepository';
import { IRepositoryOptions } from './IRepositoryOptions';

const Op = Sequelize.Op;

class ServiceRepository {

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

    // Check if frontend provided a tax id and if that tax exists.
    const taxIdProvided = data.tax || data.taxId;
    let taxRecord: any = null;
    try {
      if (taxIdProvided && options.database && options.database.tax) {
        taxRecord = await options.database.tax.findByPk(
          taxIdProvided,
          { transaction },
        );
      }
    } catch (err) {
      console.warn('Tax lookup failed before creating service', err);
    }

    // Build payload for create; only include taxId if the referenced tax exists
    const createPayload: any = {
      ...lodash.pick(data, [
        'title',
        'description',
        'price',
        'taxName',
        'taxRate',
        'importHash',
      ]),
      tenantId: tenant.id,
      createdById: currentUser.id,
      updatedById: currentUser.id,
    };

    if (taxRecord) {
      createPayload.taxId = taxRecord.id;
      createPayload.taxName = taxRecord.name;
      createPayload.taxRate = taxRecord.rate;
    }

    // Validate duplicates by title OR description within the same tenant
    try {
      const where: any = { tenantId: tenant.id };
      const orConditions: any[] = [];

      if (createPayload.title) {
        orConditions.push(
          SequelizeFilterUtils.ilikeExact(
            'service',
            'title',
            createPayload.title,
          ),
        );
      }

      if (createPayload.description) {
        orConditions.push(
          SequelizeFilterUtils.ilikeExact(
            'service',
            'description',
            createPayload.description,
          ),
        );
      }

      if (orConditions.length) {
        where[Op.or] = orConditions;
      }

      const existing = await options.database.service.findOne({
        where,
        transaction,
      });

      if (existing) {
        throw new Error400(
          options.language,
          'errors.validation.duplicate',
        );
      }
    } catch (err) {
      if (err instanceof Error400) {
        throw err;
      }
      console.warn('Duplicate check failed while creating service', err);
    }

    const record = await options.database.service.create(
      createPayload,
      {
        transaction,
      },
    );

    // If tax was not found but frontend sent taxName/taxRate, persist those snapshot fields
    try {
      if (!taxRecord && (data.taxName || data.taxRate)) {
        await record.update(
          {
            taxName: data.taxName || null,
            taxRate: data.taxRate || null,
          },
          { transaction },
        );
      }
    } catch (err) {
      console.warn('Persisting tax snapshot failed while creating service', err);
    }

    
  
    await FileRepository.replaceRelationFiles(
      {
        belongsTo: options.database.service.getTableName(),
        belongsToColumn: 'iconImage',
        belongsToId: record.id,
      },
      data.iconImage,
      options,
    );
    await FileRepository.replaceRelationFiles(
      {
        belongsTo: options.database.service.getTableName(),
        belongsToColumn: 'serviceImages',
        belongsToId: record.id,
      },
      data.serviceImages,
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

    let record = await options.database.service.findOne(
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

    // Check duplicates: if another service in tenant has same title+description, reject
    try {
      const where: any = { tenantId: currentTenant.id };
      const orConditions: any[] = [];

      if (data.title) {
        orConditions.push(
          SequelizeFilterUtils.ilikeExact('service', 'title', data.title),
        );
      }

      if (data.description) {
        orConditions.push(
          SequelizeFilterUtils.ilikeExact(
            'service',
            'description',
            data.description,
          ),
        );
      }

      if (orConditions.length) {
        where[Op.or] = orConditions;
      }

      const existing = await options.database.service.findOne({
        where: { ...where, id: { [Op.ne]: id } },
        transaction,
      });

      if (existing) {
        throw new Error400(
          options.language,
          'errors.validation.duplicate',
        );
      }
    } catch (err) {
      if (err instanceof Error400) {
        throw err;
      }
      console.warn('Duplicate check failed while updating service', err);
    }

    // Check if frontend provided a tax id and if that tax exists.
    const taxIdProvided = data.tax || data.taxId;
    let taxRecord: any = null;
    try {
      if (taxIdProvided && options.database && options.database.tax) {
        taxRecord = await options.database.tax.findByPk(
          taxIdProvided,
          { transaction },
        );
      }
    } catch (err) {
      console.warn('Tax lookup failed before updating service', err);
    }

    const updatePayload: any = {
      ...lodash.pick(data, [
        'title',
        'description',
        'price',
        'taxName',
        'taxRate',
        'importHash',
      ]),
      updatedById: currentUser.id,
    };

    if (taxRecord) {
      updatePayload.taxId = taxRecord.id;
      updatePayload.taxName = taxRecord.name;
      updatePayload.taxRate = taxRecord.rate;
    }

    record = await record.update(
      updatePayload,
      {
        transaction,
      },
    );

    // If tax wasn't found but frontend provided taxName/taxRate, persist them
    try {
      if (!taxRecord && (data.taxName || data.taxRate)) {
        await record.update(
          {
            taxName: data.taxName || null,
            taxRate: data.taxRate || null,
          },
          { transaction },
        );
      }
    } catch (err) {
      console.warn('Persisting tax snapshot failed while updating service', err);
    }



    await FileRepository.replaceRelationFiles(
      {
        belongsTo: options.database.service.getTableName(),
        belongsToColumn: 'iconImage',
        belongsToId: record.id,
      },
      data.iconImage,
      options,
    );
    await FileRepository.replaceRelationFiles(
      {
        belongsTo: options.database.service.getTableName(),
        belongsToColumn: 'serviceImages',
        belongsToId: record.id,
      },
      data.serviceImages,
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

    let record = await options.database.service.findOne(
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

    ];

    const currentTenant = SequelizeRepository.getCurrentTenant(
      options,
    );

    const record = await options.database.service.findOne(
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

    const records = await options.database.service.findAll(
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

    return options.database.service.count(
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

      if (filter.title) {
        whereAnd.push(
          SequelizeFilterUtils.ilikeIncludes(
            'service',
            'title',
            filter.title,
          ),
        );
      }

      if (filter.description) {
        whereAnd.push(
          SequelizeFilterUtils.ilikeIncludes(
            'service',
            'description',
            filter.description,
          ),
        );
      }

      if (filter.priceRange) {
        const [start, end] = filter.priceRange;

        if (start !== undefined && start !== null && start !== '') {
          whereAnd.push({
            price: {
              [Op.gte]: start,
            },
          });
        }

        if (end !== undefined && end !== null && end !== '') {
          whereAnd.push({
            price: {
              [Op.lte]: end,
            },
          });
        }
      }

      // specifications and subtitle removed from service model

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
    } = await options.database.service.findAndCountAll({
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
              'service',
              'title',
              query,
            ),
          },
        ],
      });
    }

    const where = { [Op.and]: whereAnd };

    const records = await options.database.service.findAll(
      {
        attributes: ['id', 'title'],
        where,
        limit: limit ? Number(limit) : undefined,
        order: [['title', 'ASC']],
      },
    );

    return records.map((record) => ({
      id: record.id,
      label: record.title,
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
        iconImage: data.iconImage,
        serviceImages: data.serviceImages,
      };
    }

    await AuditLogRepository.log(
      {
        entityName: 'service',
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

    output.iconImage = await FileRepository.fillDownloadUrl(
      await record.getIconImage({
        transaction,
      }),
    );

    output.serviceImages = await FileRepository.fillDownloadUrl(
      await record.getServiceImages({
        transaction,
      }),
    );

    return output;
  }
}

export default ServiceRepository;
