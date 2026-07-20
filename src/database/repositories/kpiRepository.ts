import SequelizeRepository from './sequelizeRepository';
import AuditLogRepository from './auditLogRepository';
import lodash from 'lodash';
import SequelizeFilterUtils from '../utils/sequelizeFilterUtils';
import Error404 from '../../errors/Error404';
import Sequelize from 'sequelize';
import { IRepositoryOptions } from './IRepositoryOptions';
import { computeKpiActuals } from './kpiActuals';

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
        // Presence-guarded: a partial update (e.g. toggling `active`) must not
        // wipe the KPI's guard/post-site links (Sequelize ignores undefined).
        guardId:
          data.guardId !== undefined || data.guard !== undefined
            ? (data.guardId || data.guard || null)
            : undefined,
        postSiteId:
          data.postSiteId !== undefined || data.postSite !== undefined
            ? (data.postSiteId || data.postSite || null)
            : undefined,
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

    // Per-row real activity actuals (incidents/tasks/routes for the KPI month) are
    // attached inside _fillWithRelationsAndFiles → output.actuals.
    rows = await this._fillWithRelationsAndFilesForRows(rows, options);

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

    // Real per-metric activity counts for the KPI's month (incidents/tasks/routes),
    // scoped to its guard/post-site. Replaces the old always-0 placeholder.
    try {
      const tenant = SequelizeRepository.getCurrentTenant(options);
      output.actuals = await computeKpiActuals(options.database, output, tenant && tenant.id);
    } catch {
      output.actuals = { incident: null, task: null, route: null };
    }

    return output;
  }
}

export default KpiRepository;
