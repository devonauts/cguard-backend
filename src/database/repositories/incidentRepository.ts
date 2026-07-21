import SequelizeRepository from '../../database/repositories/sequelizeRepository';
import AuditLogRepository from '../../database/repositories/auditLogRepository';
import lodash from 'lodash';
import SequelizeFilterUtils from '../../database/utils/sequelizeFilterUtils';
import Error404 from '../../errors/Error404';
import Sequelize from 'sequelize';import FileRepository from './fileRepository';
import { batchSignFiles } from '../utils/listQuery';
import { IRepositoryOptions } from './IRepositoryOptions';

const Op = Sequelize.Op;

class IncidentRepository {

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

    const record = await options.database.incident.create(
      {
        ...lodash.pick(data, [
          'date',
          'dateTime',
          'incidentAt',
          'title',
          'subject',
          'description',
          'content',
          'action',
          'postSiteId',
          'callerName',
          'callerType',
          'status',
          'workStatus',
          'dispatchStatus',
          'dispatchedAt',
          'priority',
          'internalNotes',
          'actionsTaken',
          'location',
          'comments',
          'wasRead',          
          'importHash',
        ]),
        stationId: data.stationId || data.stationIncidents || null,
        incidentTypeId: data.incidentType || null,
        postSiteId: data.postSiteId || data.siteId || null,
        clientId: data.clientId || null,
        guardNameId: data.guardNameId || null,
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
        belongsTo: options.database.incident.getTableName(),
        belongsToColumn: 'imageUrl',
        belongsToId: record.id,
      },
      data.imageUrl,
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

    let record = await options.database.incident.findOne(      
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
          'date',
          'dateTime',
          'incidentAt',
          'title',
          'subject',
          'description',
          'content',
          'action',
          'postSiteId',
          'callerName',
          'callerType',
          'status',
          'workStatus',
          'dispatchStatus',
          'dispatchedAt',
          'priority',
          'internalNotes',
          'actionsTaken',
          'location',
          'comments',
          'wasRead',          
          'importHash',
        ]),
        // Presence-guarded: editing status/notes without re-sending the FKs
        // must not wipe the incident's station/site/client/type links.
        stationId:
          data.stationId !== undefined || data.stationIncidents !== undefined
            ? (data.stationId || data.stationIncidents || null)
            : undefined,
        incidentTypeId:
          data.incidentType !== undefined || data.incidentTypeId !== undefined
            ? (data.incidentType || data.incidentTypeId || null)
            : undefined,
        postSiteId:
          data.postSiteId !== undefined || data.siteId !== undefined
            ? (data.postSiteId || data.siteId || null)
            : undefined,
        clientId: data.clientId !== undefined ? (data.clientId || null) : undefined,
        guardNameId: data.guardNameId !== undefined ? (data.guardNameId || null) : undefined,
        updatedById: currentUser.id,
      },
      {
        transaction,
      },
    );



    await FileRepository.replaceRelationFiles(
      {
        belongsTo: options.database.incident.getTableName(),
        belongsToColumn: 'imageUrl',
        belongsToId: record.id,
      },
      data.imageUrl,
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

    let record = await options.database.incident.findOne(
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
        as: 'stationIncidents',
      },
      {
        model: options.database.incidentType,
        as: 'incidentType',
      },
      {
        model: options.database.clientAccount,
        as: 'client',
      },
      {
        model: options.database.station,
        as: 'station',
      },
      {
        model: options.database.businessInfo,
        as: 'site',
      },
      {
        model: options.database.securityGuard,
        as: 'guardName',
      },
    ];

    const currentTenant = SequelizeRepository.getCurrentTenant(
      options,
    );

    const record = await options.database.incident.findOne(
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

    // If current user is not admin, ensure the incident is related to the
    // customer's assigned postSites or assigned client accounts.
    try {
      const currentUser = SequelizeRepository.getCurrentUser(options);
      let isAdmin = false;
      if (currentUser && currentUser.tenants) {
        const tenantUserRec = currentUser.tenants.find((t) => t.tenant.id === currentTenant.id && t.status === 'active');
        if (tenantUserRec) {
          let roles: any = [];
          if (Array.isArray(tenantUserRec.roles)) roles = tenantUserRec.roles;
          else if (typeof tenantUserRec.roles === 'string') {
            try { roles = JSON.parse(tenantUserRec.roles); } catch (e) { roles = []; }
          }
          // Every OFFICE / management role sees ALL incidents — not just the
          // literal admin. This MUST stay in lockstep with findAndCountAll's
          // SEES_ALL_INCIDENTS gate below, otherwise a supervisor/ops-manager/
          // dispatcher sees an incident in the LIST but 404s opening the DETAIL.
          const R = (await import('../../security/roles')).default.values;
          const SEES_ALL_INCIDENTS = [R.superadmin, R.admin, R.operationsManager, R.administrativeSupervisor, R.administrativeAssistant, R.dispatcher].filter(Boolean);
          isAdmin = roles.some((r: any) => SEES_ALL_INCIDENTS.includes(r));
        }
      }

      if (!isAdmin) {
        const tenantUser = await options.database.tenantUser.findOne({
          where: { tenantId: currentTenant.id, userId: currentUser.id },
          include: [
            { model: options.database.businessInfo, as: 'assignedPostSites', attributes: ['id'] },
            { model: options.database.clientAccount, as: 'assignedClients', attributes: ['id'] },
          ],
          transaction,
        });

        let allowedPostSiteIds = (tenantUser && tenantUser.assignedPostSites && tenantUser.assignedPostSites.map((c) => c.id)) || [];
        let allowedClientIds = (tenantUser && tenantUser.assignedClients && tenantUser.assignedClients.map((c) => c.id)) || [];

        // Customers have no explicit assignedPostSites/assignedClients. The per-
        // request auth doesn't carry clientAccountId on currentUser (only sign-in
        // sets it), so resolve it from the user link. Without this the list shows
        // an incident (its findAndCountAll has the same fallback) but opening the
        // detail 404s — the customer sees the row but can't open it.
        if (!allowedPostSiteIds.length && !allowedClientIds.length) {
          try {
            let clientAccountId = currentUser && (currentUser as any).clientAccountId;
            if (!clientAccountId) {
              const ca = await options.database.clientAccount.findOne({
                where: { userId: currentUser.id, tenantId: currentTenant.id },
                attributes: ['id'],
                transaction,
              });
              clientAccountId = ca && ca.id;
            }
            if (clientAccountId) {
              allowedClientIds = [clientAccountId];
              const posts = await options.database.businessInfo.findAll({ where: { tenantId: currentTenant.id, clientAccountId }, attributes: ['id'], transaction });
              allowedPostSiteIds = (posts || []).map((p) => p.id).filter(Boolean);
            }
          } catch (e) {
            // ignore
          }
        }

        const incidentPlain = record.get({ plain: true });

        const matchesPost = incidentPlain.postSiteId && allowedPostSiteIds.includes(incidentPlain.postSiteId);
        const matchesClient = incidentPlain.clientId && allowedClientIds.includes(incidentPlain.clientId);
        // Always let a user open an incident THEY created — mirrors the list's
        // `createdById` clause. Without this a user who filed an incident but
        // isn't assigned to its post-site sees the row but 404s on the detail.
        const isCreator = incidentPlain.createdById && String(incidentPlain.createdById) === String(currentUser.id);

        if (!matchesPost && !matchesClient && !isCreator) {
          throw new Error404();
        }
      }
    } catch (e) {
      if (e instanceof Error404) throw e;
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

    const records = await options.database.incident.findAll(
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

    return options.database.incident.count(
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
    // LEAN list (payload-perf-plan): scope every include to only the columns the
    // CRM dispatcher list/public share view and the worker incident list+detail
    // sheet actually render. The eager JOIN here already loads the relations, so
    // the previous per-row `_fillWithRelationsAndFiles` re-fetch (6 getX() + a
    // file query per row, ~7N queries/page) is pure waste — _fillForList below
    // reuses these eager rows and signs imageUrl in ONE batched query.
    // (stationIncidents alias maps to the same stationId as `station`; only
    // `station` is consumed downstream, so the duplicate include is dropped.)
    let include = [
      {
        model: options.database.incidentType,
        as: 'incidentType',
        attributes: ['id', 'name'],
      },
      {
        model: options.database.clientAccount,
        as: 'client',
        attributes: ['id', 'name', 'lastName'],
      },
      {
        model: options.database.station,
        as: 'station',
        attributes: ['id', 'stationName'],
      },
      {
        model: options.database.businessInfo,
        as: 'site',
        attributes: ['id', 'companyName', 'address'],
      },
      {
        model: options.database.securityGuard,
        as: 'guardName',
        attributes: ['id', 'fullName'],
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

      if (filter.dateRange) {
        const [start, end] = filter.dateRange;

        if (start !== undefined && start !== null && start !== '') {
          whereAnd.push({
            date: {
              [Op.gte]: start,
            },
          });
        }

        if (end !== undefined && end !== null && end !== '') {
          whereAnd.push({
            date: {
              [Op.lte]: end,
            },
          });
        }
      }

      if (filter.title) {
        whereAnd.push(
          SequelizeFilterUtils.ilikeIncludes(
            'incident',
            'title',
            filter.title,
          ),
        );
      }

      if (filter.description) {
        whereAnd.push(
          SequelizeFilterUtils.ilikeIncludes(
            'incident',
            'description',
            filter.description,
          ),
        );
      }

      if (
        filter.wasRead === true ||
        filter.wasRead === 'true' ||
        filter.wasRead === false ||
        filter.wasRead === 'false'
      ) {
        whereAnd.push({
          wasRead:
            filter.wasRead === true ||
            filter.wasRead === 'true',
        });
      }

      if (filter.stationIncidents) {
        // Support single station id or an array of station ids. The incident→
        // station link is the canonical `stationId` (stationIncidentsId merged in).
        if (Array.isArray(filter.stationIncidents)) {
          whereAnd.push({
            stationId: { [Op.in]: filter.stationIncidents.map((s) => SequelizeFilterUtils.uuid(s)) },
          });
        } else {
          whereAnd.push({
            ['stationId']: SequelizeFilterUtils.uuid(
              filter.stationIncidents,
            ),
          });
        }
      }

      if (filter.incidentType) {
        whereAnd.push({
          ['incidentTypeId']: SequelizeFilterUtils.uuid(
            filter.incidentType,
          ),
        });
      }

      if (filter.postSiteId) {
        whereAnd.push({
          ['postSiteId']: SequelizeFilterUtils.uuid(
            filter.postSiteId,
          ),
        });
      }

      if (filter.clientId) {
        whereAnd.push({
          ['clientId']: SequelizeFilterUtils.uuid(
            filter.clientId,
          ),
        });
      }

      if (filter.siteId) {
        whereAnd.push({
          ['postSiteId']: SequelizeFilterUtils.uuid(
            filter.siteId,
          ),
        });
      }

      if (filter.stationId) {
        whereAnd.push({
          ['stationId']: SequelizeFilterUtils.uuid(
            filter.stationId,
          ),
        });
      }

      if (filter.status) {
        whereAnd.push(SequelizeFilterUtils.ilikeExact('incident', 'status', filter.status));
      }

      if (filter.callerName) {
        whereAnd.push(SequelizeFilterUtils.ilikeIncludes('incident', 'callerName', filter.callerName));
      }

      if (filter.priority) {
        whereAnd.push(SequelizeFilterUtils.ilikeExact('incident', 'priority', filter.priority));
      }

      if (filter.subject) {
        whereAnd.push(SequelizeFilterUtils.ilikeIncludes('incident', 'subject', filter.subject));
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

    // If current user is not admin, restrict incidents to assigned postsites or assigned clients
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
          // Every OFFICE / management role sees ALL incidents — not just the
          // literal admin. The old admin-only check left owners/ops-managers/
          // dispatchers/custom roles with an EMPTY incidents list (the reported
          // "incidents arrive empty" bug). The assigned-post-site/client scoping
          // is only for genuinely scoped field staff.
          const R = (await import('../../security/roles')).default.values;
          const SEES_ALL_INCIDENTS = [R.superadmin, R.admin, R.operationsManager, R.administrativeSupervisor, R.administrativeAssistant, R.dispatcher].filter(Boolean);
          isAdmin = roles.some((r: any) => SEES_ALL_INCIDENTS.includes(r));
        }
      }

      if (!isAdmin) {
        const tenantUser = await options.database.tenantUser.findOne({
          where: { tenantId: tenant.id, userId: currentUser.id },
          include: [
            { model: options.database.businessInfo, as: 'assignedPostSites', attributes: ['id'] },
            { model: options.database.clientAccount, as: 'assignedClients', attributes: ['id'] },
          ],
          transaction: SequelizeRepository.getTransaction(options),
        });

        let allowedPostSiteIds = (tenantUser && tenantUser.assignedPostSites && tenantUser.assignedPostSites.map((c) => c.id)) || [];
        let allowedClientIds = (tenantUser && tenantUser.assignedClients && tenantUser.assignedClients.map((c) => c.id)) || [];

        // Customers have no explicit assignedPostSites/assignedClients. The per-
        // request auth doesn't carry clientAccountId on currentUser (only sign-in
        // sets it), so resolve it from the user link — same fallback as findById.
        // Without the clientAccount.findOne fallback the list comes back EMPTY for
        // a customer whose token lacks clientAccountId, even though the detail path
        // (with the fallback) would resolve their posts.
        if (!allowedPostSiteIds.length && !allowedClientIds.length) {
          try {
            let clientAccountId = currentUser && (currentUser as any).clientAccountId;
            if (!clientAccountId) {
              const ca = await options.database.clientAccount.findOne({
                where: { userId: currentUser.id, tenantId: tenant.id },
                attributes: ['id'],
                transaction: SequelizeRepository.getTransaction(options),
              });
              clientAccountId = ca && ca.id;
            }
            if (clientAccountId) {
              allowedClientIds = [clientAccountId];
              const posts = await options.database.businessInfo.findAll({ where: { tenantId: tenant.id, clientAccountId }, attributes: ['id'], transaction: SequelizeRepository.getTransaction(options) });
              allowedPostSiteIds = (posts || []).map((p) => p.id).filter(Boolean);
            }
          } catch (e) {
            // ignore
          }
        }

        const clauses: any[] = [];
        if (allowedPostSiteIds.length) clauses.push({ postSiteId: { [Op.in]: allowedPostSiteIds } });
        if (allowedClientIds.length) clauses.push({ clientId: { [Op.in]: allowedClientIds } });
        // Always let a user see incidents THEY created — a guard/dispatcher who
        // filed one but isn't assigned to that post-site would otherwise never see
        // it (and this stops the "empty" result when they have no assignments).
        clauses.push({ createdById: currentUser.id });

        whereAnd.push(clauses.length === 1 ? clauses[0] : { [Op.or]: clauses });
      }
    } catch (e) {
      // ignore and proceed
    }

    const where = { [Op.and]: whereAnd };

    // Defensive pagination: omitting ?limit used to return the ENTIRE tenant
    // incident history (limit: undefined → no LIMIT) through 5 joins plus the
    // photo-signing pass. Default well above every real consumer's page size
    // (CRM views send ≤999, worker app ≤500, control center 50) and hard-cap
    // so a single request can never dump the table.
    const effectiveLimit = Math.min(
      Number(limit) > 0 ? Number(limit) : 1000,
      5000,
    );

    let {
      rows,
      count,
    } = await options.database.incident.findAndCountAll({
      where,
      // Drop list-irrelevant TEXT blobs (internalNotes/actionsTaken/action/
      // importHash) — the CRM list/Excel and worker detail re-read those only
      // from the full findById/detail fetch, never the list row. Everything the
      // worker IncidentDetailSheet renders inline (subject/title/description/
      // content/comments/location/priority/status/dates) is kept.
      attributes: {
        exclude: ['internalNotes', 'actionsTaken', 'action', 'importHash'],
      },
      include,
      limit: effectiveLimit,
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

  /**
   * LEAN list enricher — reuses the eager-loaded (scoped) relations already on
   * each row and signs the incident evidence photos (imageUrl) for ALL rows in
   * ONE batched file query, instead of the old per-row `_fillWithRelationsAndFiles`
   * which re-fetched 6 relations + a file query per row. Keeps the exact consumed
   * shape: imageUrl + incidentType/client/site/station/guardName.
   * (The worker IncidentDetailSheet renders imageUrl thumbnails straight off the
   * list row, so photos MUST be signed here — there is no separate detail fetch.)
   * findById keeps the full _fillWithRelationsAndFiles.
   */
  static async _fillForList(rows, options: IRepositoryOptions) {
    if (!rows || !rows.length) return rows;

    const outputs = rows.map((r) => r.get({ plain: true }));

    // Sign evidence photos for every row in one file.findAll (batchSignFiles
    // sets output.imageUrl to the signed descriptors per row id).
    await batchSignFiles(
      options.database,
      outputs as any[],
      options.database.incident.getTableName(),
      'imageUrl',
    );

    return outputs;
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

    const records = await options.database.incident.findAll(
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
        imageUrl: data.imageUrl,
      };
    }

    await AuditLogRepository.log(
      {
        entityName: 'incident',
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

    output.imageUrl = await FileRepository.fillDownloadUrl(
      await record.getImageUrl({
        transaction,
      }),
    );

    // incidentType relation
    const incidentType = await record.getIncidentType({ transaction });
    output.incidentType = incidentType ? incidentType.get({ plain: true }) : null;

    const client = await record.getClient ? await record.getClient({ transaction }) : null;
    output.client = client ? client.get({ plain: true }) : null;

    const site = await record.getSite ? await record.getSite({ transaction }) : null;
    output.site = site ? site.get({ plain: true }) : null;

    const station = await record.getStation ? await record.getStation({ transaction }) : null;
    output.station = station ? station.get({ plain: true }) : null;

    const guardName = await record.getGuardName ? await record.getGuardName({ transaction }) : null;
    output.guardName = guardName ? guardName.get({ plain: true }) : null;

    return output;
  }
}

export default IncidentRepository;
