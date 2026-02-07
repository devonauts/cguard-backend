import SequelizeRepository from './sequelizeRepository';
import AuditLogRepository from './auditLogRepository';
import lodash from 'lodash';
import SequelizeFilterUtils from '../utils/sequelizeFilterUtils';
import Error404 from '../../errors/Error404';
import Sequelize from 'sequelize';
import { IRepositoryOptions } from './IRepositoryOptions';

const Op = Sequelize.Op;

class KpiRepository {
  static async create(data, options: IRepositoryOptions) {
    const currentUser = SequelizeRepository.getCurrentUser(options);
    const tenant = SequelizeRepository.getCurrentTenant(options);
    const transaction = SequelizeRepository.getTransaction(options);

    const record = await options.database.kpi.create(
      {
        ...lodash.pick(data, [
          'scope',
          'frequency',
          'description',
          'reportOptions',
          'emailNotification',
          'emails',
          'active',
          'importHash',
          'standardReports',
          'standardReportsNumber',
          'incidentReports',
          'incidentReportsNumber',
          'routeReports',
          'routeReportsNumber',
          'taskReports',
          'taskReportsNumber',
          'verificationReports',
          'verificationReportsNumber',
        ]),
        guardId: data.guardId || data.guard || null,
        postSiteId: data.postSiteId || data.postSite || null,
        tenantId: tenant.id,
        createdById: currentUser.id,
        updatedById: currentUser.id,
      },
      { transaction },
    );

    await this._createAuditLog(AuditLogRepository.CREATE, record, data, options);
    return this.findById(record.id, options);
  }

  static async update(id, data, options: IRepositoryOptions) {
    const currentUser = SequelizeRepository.getCurrentUser(options);
    const transaction = SequelizeRepository.getTransaction(options);
    const currentTenant = SequelizeRepository.getCurrentTenant(options);

    let record = await options.database.kpi.findOne({ where: { id, tenantId: currentTenant.id }, transaction });
    if (!record) {
      throw new Error404();
    }

    record = await record.update(
      {
        ...lodash.pick(data, [
          'scope',
          'frequency',
          'description',
          'reportOptions',
          'emailNotification',
          'emails',
          'active',
          'importHash',
          'standardReports',
          'standardReportsNumber',
          'incidentReports',
          'incidentReportsNumber',
          'routeReports',
          'routeReportsNumber',
          'taskReports',
          'taskReportsNumber',
          'verificationReports',
          'verificationReportsNumber',
        ]),
        guardId: data.guardId || data.guard || null,
        postSiteId: data.postSiteId || data.postSite || null,
        updatedById: currentUser.id,
      },
      { transaction },
    );

    await this._createAuditLog(AuditLogRepository.UPDATE, record, data, options);
    return this.findById(record.id, options);
  }

  static async destroy(id, options: IRepositoryOptions) {
    const transaction = SequelizeRepository.getTransaction(options);
    const currentTenant = SequelizeRepository.getCurrentTenant(options);

    let record = await options.database.kpi.findOne({ where: { id, tenantId: currentTenant.id }, transaction });
    if (!record) {
      throw new Error404();
    }

    await record.destroy({ transaction });

    await this._createAuditLog(AuditLogRepository.DELETE, record, record, options);
  }

  static async findById(id, options: IRepositoryOptions) {
    const transaction = SequelizeRepository.getTransaction(options);

    const currentTenant = SequelizeRepository.getCurrentTenant(options);

    const include = [
      { model: options.database.user, as: 'createdBy' },
      { model: options.database.securityGuard, as: 'guard', required: false },
      { model: options.database.businessInfo, as: 'postSite', required: false },
    ];

    const record = await options.database.kpi.findOne({ where: { id, tenantId: currentTenant.id }, include, transaction });
    if (!record) {
      throw new Error404();
    }
    return this._fillWithRelationsAndFiles(record, options);
  }

  static async count(filter, options: IRepositoryOptions) {
    const transaction = SequelizeRepository.getTransaction(options);
    const tenant = SequelizeRepository.getCurrentTenant(options);
    return options.database.kpi.count({ where: { ...filter, tenantId: tenant.id }, transaction });
  }

  static async findAndCountAll({ filter, limit = 0, offset = 0, orderBy = '' }, options: IRepositoryOptions) {
    const tenant = SequelizeRepository.getCurrentTenant(options);

    let whereAnd: Array<any> = [];
    whereAnd.push({ tenantId: tenant.id });

    if (filter) {
      if (filter.id) {
        whereAnd.push({ ['id']: SequelizeFilterUtils.uuid(filter.id) });
      }

      if (filter.scope) {
        whereAnd.push({ ['scope']: filter.scope });
      }

      if (filter.guard) {
        whereAnd.push({ ['guardId']: SequelizeFilterUtils.uuid(filter.guard) });
      }

      if (filter.postSite) {
        whereAnd.push({ ['postSiteId']: SequelizeFilterUtils.uuid(filter.postSite) });
      }

      if (filter.description) {
        whereAnd.push(SequelizeFilterUtils.ilikeIncludes('kpi', 'description', filter.description));
      }
    }

    const where = { [Op.and]: whereAnd };

    const include = [
      { model: options.database.user, as: 'createdBy' },
      { model: options.database.securityGuard, as: 'guard', required: false },
      { model: options.database.businessInfo, as: 'postSite', required: false },
    ];

    let { rows, count } = await options.database.kpi.findAndCountAll({ where, limit: limit ? Number(limit) : undefined, offset: offset ? Number(offset) : undefined, order: orderBy ? [orderBy.split('_')] : [['createdAt', 'DESC']], transaction: SequelizeRepository.getTransaction(options), include });

    rows = await this._fillWithRelationsAndFilesForRows(rows, options);

    // If a month filter was provided, compute 'actual' values for each KPI based on report counts
    try {
      if (filter && filter.month) {
        const month = String(filter.month); // expected YYYY-MM
        const parts = month.split('-');
        if (parts.length === 2) {
          const year = Number(parts[0]);
          const monthIndex = Number(parts[1]) - 1; // JS Date month index
          const start = new Date(Date.UTC(year, monthIndex, 1, 0, 0, 0));
          const end = new Date(Date.UTC(year, monthIndex + 1, 1, 0, 0, 0));

          // For each KPI row, compute a simple 'actual' metric as count of reports in that month.
          // Note: This is a generic implementation — refine later to scope counts by postSite/guard.
          for (const r of rows) {
            const whereReport: any = {
              tenantId: tenant.id,
              createdAt: { [Op.gte]: start, [Op.lt]: end },
            };
            const cnt = await options.database.report.count({ where: whereReport, transaction: SequelizeRepository.getTransaction(options) });
            // attach actual count to the output object
            if (r && typeof r === 'object') {
              r.actual = cnt;
            }
          }
        }
      }
    } catch (err) {
      // Do not fail the entire request if counting reports fails; just log
      // eslint-disable-next-line no-console
      console.error('Error computing KPI actual values', err);
    }

    return { rows, count };
  }

  static async findAllAutocomplete(query, limit, options: IRepositoryOptions) {
    const tenant = SequelizeRepository.getCurrentTenant(options);
    let whereAnd: Array<any> = [{ tenantId: tenant.id }];

    if (query) {
      whereAnd.push({
        [Op.or]: [
          { ['id']: SequelizeFilterUtils.uuid(query) },
          { [Op.and]: SequelizeFilterUtils.ilikeIncludes('kpi', 'description', query) },
        ],
      });
    }

    const where = { [Op.and]: whereAnd };

    const records = await options.database.kpi.findAll({ attributes: ['id', 'description'], where, limit: limit ? Number(limit) : undefined, transaction: SequelizeRepository.getTransaction(options) });

    return records.map((record) => ({ id: record.id, label: record.description }));
  }

  static async _createAuditLog(action, record, data, options) {
    let values = {};

    if (data) {
      values = {
        ...record.get({ plain: true }),
      };
    }

    await AuditLogRepository.log(
      {
        entityName: 'kpi',
        entityId: record.id,
        action,
        values,
      },
      options,
    );
  }

  static async _fillWithRelationsAndFilesForRows(rows, options: IRepositoryOptions) {
    if (!rows) {
      return rows;
    }

    return Promise.all(
      rows.map((record) => this._fillWithRelationsAndFiles(record, options)),
    );
  }

  static async _fillWithRelationsAndFiles(record, options: IRepositoryOptions) {
    if (!record) {
      return record;
    }

    const output = record.get({ plain: true });

    // Add helper fields the frontend expects
    output.type = output.description || output.scope;
    output.dateTime = output.createdAt;

    if (output.createdBy) {
      output.addedBy = output.createdBy.fullName || output.createdBy.email || output.createdBy.id;
    } else {
      output.addedBy = null;
    }

    // Clean relations to minimal shape
    output.guard = output.guard ? { id: output.guard.id, fullName: output.guard.fullName || null } : null;
    output.postSite = output.postSite ? { id: output.postSite.id, businessName: output.postSite.businessName || output.postSite.name || null } : null;

    return output;
  }
}

export default KpiRepository;
