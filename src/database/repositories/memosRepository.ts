import SequelizeRepository from '../../database/repositories/sequelizeRepository';
import AuditLogRepository from '../../database/repositories/auditLogRepository';
import lodash from 'lodash';
import SequelizeFilterUtils from '../../database/utils/sequelizeFilterUtils';
import Error404 from '../../errors/Error404';
import Sequelize from 'sequelize';import FileRepository from './fileRepository';
import { IRepositoryOptions } from './IRepositoryOptions';

const Op = Sequelize.Op;

class MemosRepository {

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

    const record = await options.database.memos.create(
      {
        ...lodash.pick(data, [
          'dateTime',
          'subject',
          'content',
          'wasAccepted',
          'importHash',
          'type',
          'guardRatingId',
        ]),
        guardNameId: data.guardName || null,
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
        belongsTo: options.database.memos.getTableName(),
        belongsToColumn: 'memoDocumentPdf',
        belongsToId: record.id,
      },
      data.memoDocumentPdf,
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

    let record = await options.database.memos.findOne(      
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
          'dateTime',
          'subject',
          'content',
          'wasAccepted',
          'importHash',
          'type',
          'guardRatingId',
        ]),
        guardNameId: data.guardName !== undefined ? (data.guardName || null) : undefined,
        updatedById: currentUser.id,
      },
      {
        transaction,
      },
    );



    await FileRepository.replaceRelationFiles(
      {
        belongsTo: options.database.memos.getTableName(),
        belongsToColumn: 'memoDocumentPdf',
        belongsToId: record.id,
      },
      data.memoDocumentPdf,
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

    let record = await options.database.memos.findOne(
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
        model: options.database.securityGuard,
        as: 'guardName',
      },
      {
        model: options.database.user,
        as: 'createdBy',
        // Never SELECT * a user into a payload — strip the secrets.
        attributes: { exclude: ['password', 'emailVerificationToken', 'passwordResetToken', 'importHash'] },
      },
    ];

    const currentTenant = SequelizeRepository.getCurrentTenant(
      options,
    );

    const record = await options.database.memos.findOne(
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

    const records = await options.database.memos.findAll(
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

    return options.database.memos.count(
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
        model: options.database.securityGuard,
        as: 'guardName',
        // LIST: the CRM only renders the guard's display name (via fullName)
        // and id; never SELECT * the whole securityGuard row into the payload.
        attributes: ['id', 'fullName'],
      },
      {
        model: options.database.user,
        as: 'createdBy',
        // Never SELECT * a user into a payload — strip the secrets.
        // (createdBy stays scoped as-is; the CRM reads fullName/firstName/lastName/email.)
        attributes: { exclude: ['password', 'emailVerificationToken', 'passwordResetToken', 'importHash'] },
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

      if (filter.dateTimeRange) {
        const [start, end] = filter.dateTimeRange;

        if (start !== undefined && start !== null && start !== '') {
          whereAnd.push({
            dateTime: {
              [Op.gte]: start,
            },
          });
        }

        if (end !== undefined && end !== null && end !== '') {
          whereAnd.push({
            dateTime: {
              [Op.lte]: end,
            },
          });
        }
      }

      if (filter.guardName) {
        whereAnd.push({
          ['guardNameId']: SequelizeFilterUtils.uuid(
            filter.guardName,
          ),
        });
      }

      if (filter.subject) {
        whereAnd.push(
          SequelizeFilterUtils.ilikeIncludes(
            'memos',
            'subject',
            filter.subject,
          ),
        );
      }

      if (filter.content) {
        whereAnd.push(
          SequelizeFilterUtils.ilikeIncludes(
            'memos',
            'content',
            filter.content,
          ),
        );
      }

      if (filter.ids && Array.isArray(filter.ids) && filter.ids.length) {
        whereAnd.push({
          ['id']: {
            [Op.in]: filter.ids.map((id) => SequelizeFilterUtils.uuid(id)),
          },
        });
      }

      if (
        filter.wasAccepted === true ||
        filter.wasAccepted === 'true' ||
        filter.wasAccepted === false ||
        filter.wasAccepted === 'false'
      ) {
        whereAnd.push({
          wasAccepted:
            filter.wasAccepted === true ||
            filter.wasAccepted === 'true',
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
    } = await options.database.memos.findAndCountAll({
      // LIST: explicit attributes (never SELECT *). content stays because the
      // CRM memos "Ver" dialog + guard-summary feed render it; there are no big
      // blobs on memos to drop.
      attributes: [
        'id',
        'dateTime',
        'subject',
        'content',
        'wasAccepted',
        'guardNameId',
        'createdById',
        'updatedById',
        'tenantId',
        'createdAt',
        'updatedAt',
      ],
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

    // LIST: no per-row file signing. memoDocumentPdf is never rendered by any
    // CRM/worker memos surface — it is signed only on findById. _fillForList
    // just flattens rows (keeps guardName + createdBy includes).
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

    if (query) {
      whereAnd.push({
        [Op.or]: [
          { ['id']: SequelizeFilterUtils.uuid(query) },

        ],
      });
    }

    const where = { [Op.and]: whereAnd };

    const records = await options.database.memos.findAll(
      {
        attributes: ['id', 'id'],
        where,
        limit: limit ? Number(limit) : undefined,
        order: [['id', 'ASC']],
      },
    );

    return records.map((record) => ({
      id: record.id,
      label: record.id,
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
        memoDocumentPdf: data.memoDocumentPdf,
      };
    }

    await AuditLogRepository.log(
      {
        entityName: 'memos',
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

  // LIST-only flattener: returns the consumed shape (root columns + scoped
  // guardName + createdBy includes) WITHOUT signing memoDocumentPdf. The
  // full file enrichment stays on findById.
  static async _fillForList(rows, options: IRepositoryOptions) {
    if (!rows) {
      return rows;
    }
    return rows.map((record) => (record as any).get({ plain: true }));
  }

  static async _fillWithRelationsAndFiles(record, options: IRepositoryOptions) {
    if (!record) {
      return record;
    }

    const output = record.get({ plain: true });

    const transaction = SequelizeRepository.getTransaction(
      options,
    );

    output.memoDocumentPdf = await FileRepository.fillDownloadUrl(
      await record.getMemoDocumentPdf({
        transaction,
      }),
    );

    return output;
  }
}

export default MemosRepository;
