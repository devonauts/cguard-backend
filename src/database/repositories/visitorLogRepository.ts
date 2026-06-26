import SequelizeRepository from '../../database/repositories/sequelizeRepository';
import AuditLogRepository from '../../database/repositories/auditLogRepository';
import lodash from 'lodash';
import SequelizeFilterUtils from '../../database/utils/sequelizeFilterUtils';
import Error404 from '../../errors/Error404';
import Sequelize from 'sequelize';import Roles from '../../security/roles';import FileRepository from './fileRepository';
import { IRepositoryOptions } from './IRepositoryOptions';

const Op = Sequelize.Op;

class VisitorLogRepository {
  static async create(data, options: IRepositoryOptions) {
    const currentUser = SequelizeRepository.getCurrentUser(options);
    const tenant = SequelizeRepository.getCurrentTenant(options);
    const transaction = SequelizeRepository.getTransaction(options);

    const toCreate = {
      ...lodash.pick(data, [
        'visitDate',
        'lastName',
        'firstName',
        'idNumber',
        'reason',
        'exitTime',
        'numPeople',
        'importHash',
        'clientId',
        'postSiteId',
        'stationId',
        'stationName',
        'placeType',
        'idType',
        'personVisited',
        'company',
        'vehiclePlate',
        'vehicleType',
        'phone',
        'birthDate',
        'idExpiry',
        'tagNumber',
        'archived',
      ]),
    };

    // Normalize empty exitTime to null
    if (!toCreate.exitTime) {
      toCreate.exitTime = null;
    }

    // ── Attribution: every visit a guard registers must roll up to the post they
    // are actually working — station → postSite → client. Without it the visit is
    // orphaned and invisible to the client + post-scoped staff (only admins, who
    // see every tenant row, can find it). The worker-app only sends a station when
    // the guard has a PERMANENT junction assignment AND the dashboard fetch that
    // feeds it succeeded; guards working via the scheduler, clocked in ad-hoc, or
    // whose dashboard call failed send nothing. So when station/post are missing,
    // resolve them server-side from — in priority order — the guard's CURRENT
    // scheduled shift, their ACTIVE clock-in (where they physically are right
    // now), their permanent station junction, then any assigned post site. Each
    // step is best-effort; we then complete the chain (station → postSite →
    // client) from whichever link we landed.
    try {
      const { Op } = options.database.Sequelize;
      const userId = currentUser && currentUser.id;
      const now = new Date();

      // 1) Current scheduled shift (exact now-window) — most precise.
      if (!toCreate.stationId && !toCreate.postSiteId && userId) {
        const currentShift = await options.database.shift.findOne({
          where: {
            guardId: userId,
            tenantId: tenant.id,
            startTime: { [Op.lte]: now },
            endTime: { [Op.gte]: now },
          },
          order: [['startTime', 'DESC']],
          attributes: ['stationId', 'postSiteId'],
          transaction,
        });
        if (currentShift) {
          if (currentShift.stationId) toCreate.stationId = currentShift.stationId;
          if (currentShift.postSiteId) toCreate.postSiteId = currentShift.postSiteId;
        }
      }

      // The next two fallbacks key off the guard's securityGuard row / user id.
      let securityGuardId: string | null = null;
      if (!toCreate.stationId && !toCreate.postSiteId && userId) {
        const sg = await options.database.securityGuard
          .findOne({ where: { guardId: userId, tenantId: tenant.id, deletedAt: null }, attributes: ['id'], transaction })
          .catch(() => null);
        securityGuardId = sg && sg.id;
      }

      // 2) Active clock-in (guardShift still open) — where the guard physically is.
      if (!toCreate.stationId && !toCreate.postSiteId && securityGuardId) {
        const activeClockIn = await options.database.guardShift
          .findOne({
            where: { guardNameId: securityGuardId, punchOutTime: null, tenantId: tenant.id },
            order: [['punchInTime', 'DESC']],
            attributes: ['stationNameId', 'postSiteId'],
            transaction,
          })
          .catch(() => null);
        if (activeClockIn) {
          if (activeClockIn.stationNameId) toCreate.stationId = activeClockIn.stationNameId;
          if (activeClockIn.postSiteId) toCreate.postSiteId = activeClockIn.postSiteId;
        }
      }

      // 3) Permanent station junction (station ⇄ guard) — safety net for when the
      // worker-app dashboard that normally supplies this didn't load.
      if (!toCreate.stationId && !toCreate.postSiteId && userId) {
        const st = await options.database.station
          .findOne({
            where: { tenantId: tenant.id, deletedAt: null },
            attributes: ['id', 'postSiteId'],
            include: [{
              model: options.database.user,
              as: 'assignedGuards',
              where: { id: userId },
              attributes: [],
              through: { attributes: [] },
              required: true,
            }],
            order: [['createdAt', 'DESC']],
            transaction,
          })
          .catch(() => null);
        if (st) {
          if (st.id) toCreate.stationId = st.id;
          if (st.postSiteId) toCreate.postSiteId = st.postSiteId;
        }
      }

      // 4) Assigned post site (tenant_user ⇄ businessInfo) — last resort, gives at
      // least the post/client even when no specific station is known.
      if (!toCreate.postSiteId && userId) {
        const tu = await options.database.tenantUser
          .findOne({
            where: { userId, tenantId: tenant.id },
            include: [{ model: options.database.businessInfo, as: 'assignedPostSites', attributes: ['id'] }],
            transaction,
          })
          .catch(() => null);
        const firstPost = tu && tu.assignedPostSites && tu.assignedPostSites[0];
        if (firstPost && firstPost.id) toCreate.postSiteId = firstPost.id;
      }

      // station → postSite
      if (toCreate.stationId && !toCreate.postSiteId) {
        const st = await options.database.station.findByPk(toCreate.stationId, { attributes: ['postSiteId'], transaction }).catch(() => null);
        if (st && st.postSiteId) toCreate.postSiteId = st.postSiteId;
      }
      // postSite → client
      if (toCreate.postSiteId && !toCreate.clientId) {
        const bi = await options.database.businessInfo.findByPk(toCreate.postSiteId, { attributes: ['clientAccountId'], transaction }).catch(() => null);
        if (bi && bi.clientAccountId) toCreate.clientId = bi.clientAccountId;
      }
    } catch (e) {
      console.warn('[visitorLog.create] attribution lookup failed (non-fatal):', (e && (e as any).message) || e);
    }

    // Determine denormalized stationName (if not provided) from the station record
    let denormStationName = toCreate.stationName;
    if (!denormStationName && toCreate.stationId) {
      const st = await options.database.station.findByPk(toCreate.stationId).catch(() => null);
      if (st) denormStationName = st.stationName || st.name || undefined;
    }

    const record = await options.database.visitorLog.create(
      {
        ...toCreate,
        stationName: denormStationName,
        tenantId: tenant.id,
        createdById: currentUser.id,
        updatedById: currentUser.id,
      },
      { transaction },
    );

    await this._createAuditLog(AuditLogRepository.CREATE, record, data, options);

    await FileRepository.replaceRelationFiles(
      {
        belongsTo: 'visitorLog',
        belongsToColumn: 'idPhoto',
        belongsToId: record.id,
      },
      data.idPhoto,
      { ...options, transaction },
    );

    await FileRepository.replaceRelationFiles(
      {
        belongsTo: 'visitorLog',
        belongsToColumn: 'facePhoto',
        belongsToId: record.id,
      },
      data.facePhoto,
      { ...options, transaction },
    );

    // Return the just-written record WITHOUT the assigned-post-site read ACL —
    // the creator/editor (e.g. a guard not tied to a post site) must always get
    // back what they saved. Otherwise findById's ACL 404s and the save looks
    // like it failed ("Extraviado") even though it was stored.
    return this.findById(record.id, { ...options, bypassPermissionValidation: true });
  }

  static async update(id, data, options: IRepositoryOptions) {
    const currentUser = SequelizeRepository.getCurrentUser(options);
    const transaction = SequelizeRepository.getTransaction(options);
    const currentTenant = SequelizeRepository.getCurrentTenant(options);

    let record = await options.database.visitorLog.findOne({
      where: { id, tenantId: currentTenant.id },
      transaction,
    });

    if (!record) {
      throw new Error404();
    }

    const toUpdate = {
      ...lodash.pick(data, [
        'visitDate',
        'lastName',
        'firstName',
        'idNumber',
        'reason',
        'exitTime',
        'numPeople',
        'importHash',
        'clientId',
        'postSiteId',
        'stationId',
        'stationName',
        'placeType',
        'idType',
        'personVisited',
        'company',
        'vehiclePlate',
        'vehicleType',
        'phone',
        'birthDate',
        'idExpiry',
        'tagNumber',
        'archived',
      ]),
    };

    // Normalize empty exitTime to null
    if (toUpdate.exitTime === '' || toUpdate.exitTime === undefined) {
      toUpdate.exitTime = null;
    }

    // Determine denormalized stationName for update
    let denormUpdateStationName = toUpdate.stationName;
    if (denormUpdateStationName === undefined && toUpdate.stationId) {
      const st = await options.database.station.findByPk(toUpdate.stationId).catch(() => null);
      if (st) denormUpdateStationName = st.stationName || st.name || undefined;
    }

    record = await record.update(
      {
        ...toUpdate,
        stationName: denormUpdateStationName !== undefined ? denormUpdateStationName : record.stationName,
        updatedById: currentUser.id,
      },
      { transaction },
    );

    await this._createAuditLog(AuditLogRepository.UPDATE, record, data, options);

    await FileRepository.replaceRelationFiles(
      {
        belongsTo: 'visitorLog',
        belongsToColumn: 'idPhoto',
        belongsToId: record.id,
      },
      data.idPhoto,
      { ...options, transaction },
    );

    await FileRepository.replaceRelationFiles(
      {
        belongsTo: 'visitorLog',
        belongsToColumn: 'facePhoto',
        belongsToId: record.id,
      },
      data.facePhoto,
      { ...options, transaction },
    );

    // Return the just-written record WITHOUT the assigned-post-site read ACL —
    // the creator/editor (e.g. a guard not tied to a post site) must always get
    // back what they saved. Otherwise findById's ACL 404s and the save looks
    // like it failed ("Extraviado") even though it was stored.
    return this.findById(record.id, { ...options, bypassPermissionValidation: true });
  }

  static async destroy(id, options: IRepositoryOptions) {
    const transaction = SequelizeRepository.getTransaction(options);
    const currentTenant = SequelizeRepository.getCurrentTenant(options);

    let record = await options.database.visitorLog.findOne({
      where: { id, tenantId: currentTenant.id },
      transaction,
    });

    if (!record) {
      throw new Error404();
    }

    await record.destroy({ transaction });

    await this._createAuditLog(AuditLogRepository.DELETE, record, record, options);
  }

  static async findById(id, options: IRepositoryOptions) {
    const transaction = SequelizeRepository.getTransaction(options);

    const include = [];

    const currentTenant = SequelizeRepository.getCurrentTenant(options);
    const assignedAcl = await this._buildAssignedVisitorLogAcl(options);

    const where: any = { id, tenantId: currentTenant.id };
    if (assignedAcl) {
      if (!assignedAcl.hasAssigned) {
        throw new Error404();
      }
      where[Op.and] = [
        { id, tenantId: currentTenant.id },
        assignedAcl.where,
      ];
    }

    const record = await options.database.visitorLog.findOne({
      where,
      include,
      transaction,
    });

    if (!record) {
      throw new Error404();
    }

    return this._fillWithRelationsAndFiles(record, options);
  }

  static async filterIdInTenant(id, options: IRepositoryOptions) {
    return lodash.get(await this.filterIdsInTenant([id], options), '[0]', null);
  }

  static async filterIdsInTenant(ids, options: IRepositoryOptions) {
    if (!ids || !ids.length) {
      return [];
    }

    const currentTenant = SequelizeRepository.getCurrentTenant(options);

    const where = { id: { [Op.in]: ids }, tenantId: currentTenant.id };

    const records = await options.database.visitorLog.findAll({ attributes: ['id'], where });

    return records.map((record) => record.id);
  }

  static async _buildAssignedVisitorLogAcl(options: IRepositoryOptions) {
    const currentUser = SequelizeRepository.getCurrentUser(options);
    const currentTenant = SequelizeRepository.getCurrentTenant(options);
    const transaction = SequelizeRepository.getTransaction(options);
    const bypass = options && (options as any).bypassPermissionValidation;

    if (!currentUser || !currentTenant || bypass) {
      return null;
    }

    const tenantUserRec = (Array.isArray(currentUser.tenants) ? currentUser.tenants : [])
      .find(
        (t) =>
          t &&
          t.tenant &&
          String(t.tenant.id) === String(currentTenant.id) &&
          t.status === 'active',
      );

    if (!tenantUserRec) {
      return null;
    }

    let roles: any = [];
    if (Array.isArray(tenantUserRec.roles)) {
      roles = tenantUserRec.roles;
    } else if (typeof tenantUserRec.roles === 'string') {
      try {
        roles = JSON.parse(tenantUserRec.roles);
      } catch (error) {
        roles = [tenantUserRec.roles];
      }
    }

    if (Array.isArray(roles) ? roles.includes(Roles.values.admin) : String(roles) === Roles.values.admin) {
      return null;
    }

    let assignedPostSiteIds = Array.isArray(tenantUserRec.assignedPostSites)
      ? tenantUserRec.assignedPostSites.map((p) => p && p.id).filter(Boolean)
      : [];

    let tenantUserId = tenantUserRec.id;
    if (!tenantUserId) {
      const tenantUser = await options.database.tenantUser.findOne({
        where: {
          userId: currentUser.id,
          tenantId: currentTenant.id,
        },
        attributes: ['id'],
        transaction,
      });
      tenantUserId = tenantUser && tenantUser.id;
    }

    if (!assignedPostSiteIds.length && tenantUserId) {
      const tenantUserWithPosts = await options.database.tenantUser.findOne({
        where: { id: tenantUserId },
        include: [{ model: options.database.businessInfo, as: 'assignedPostSites', attributes: ['id'] }],
        transaction,
      });

      assignedPostSiteIds = (tenantUserWithPosts && tenantUserWithPosts.assignedPostSites || [])
        .map((p) => p && p.id)
        .filter(Boolean);
    }

    let assignedStationIds: any[] = [];
    if (
      tenantUserId &&
      options.database.tenant_user_post_sites &&
      options.database.tenant_user_post_sites.rawAttributes &&
      Object.prototype.hasOwnProperty.call(options.database.tenant_user_post_sites.rawAttributes, 'station_id')
    ) {
      const stationRows = await options.database.tenant_user_post_sites.findAll({
        where: {
          tenantUserId,
          station_id: { [Op.ne]: null },
        },
        attributes: ['station_id'],
        group: ['station_id'],
        transaction,
      });

      assignedStationIds = (stationRows || []).map((row) => row && row.station_id).filter(Boolean);
    }

    // Security guards are assigned to stations via the station<->user junction
    // (`station.assignedGuards`), not via tenant_user_post_sites. Recognize those
    // direct station assignments so guards can manage their station's visitor logs.
    try {
      const guardStations = await options.database.station.findAll({
        where: { tenantId: currentTenant.id, deletedAt: null },
        attributes: ['id', 'postSiteId'],
        include: [{
          model: options.database.user,
          as: 'assignedGuards',
          where: { id: currentUser.id },
          attributes: [],
          through: { attributes: [] },
          required: true,
        }],
        transaction,
      });
      for (const st of (guardStations || [])) {
        if (st && st.id) assignedStationIds.push(st.id);
        if (st && st.postSiteId) assignedPostSiteIds.push(st.postSiteId);
      }
      assignedStationIds = Array.from(new Set(assignedStationIds));
      assignedPostSiteIds = Array.from(new Set(assignedPostSiteIds));
    } catch (e) {
      // association may not exist in some schemas — ignore and fall through
    }

    if (!assignedPostSiteIds.length && !assignedStationIds.length) {
      // If user has clientAccountId (customer), allow posts belonging to that client
      try {
        const clientAccountId = currentUser && (currentUser as any).clientAccountId;
        if (clientAccountId) {
          const posts = await options.database.businessInfo.findAll({ where: { tenantId: currentTenant.id, clientAccountId }, attributes: ['id'], transaction });
          assignedPostSiteIds = (posts || []).map((p) => p && p.id).filter(Boolean);
        }
      } catch (e) {
        // ignore
      }
    }

    // A non-admin can ALWAYS see visitor logs they themselves registered — even
    // when the visit's station/post falls outside their assigned scope (e.g. a
    // guard on duty via the schedule rather than a permanent post/station
    // assignment). Without this, a guard who just registered a visit is bounced
    // to an empty "no visitors logged yet" list.
    const allowedClauses: any[] = [{ createdById: currentUser.id }];
    if (assignedPostSiteIds.length) {
      allowedClauses.push({ postSiteId: { [Op.in]: assignedPostSiteIds } });
    }
    if (assignedStationIds.length) {
      allowedClauses.push({ stationId: { [Op.in]: assignedStationIds } });
    }

    return {
      hasAssigned: true,
      where: allowedClauses.length === 1 ? allowedClauses[0] : { [Op.or]: allowedClauses },
    };
  }

  static async count(filter, options: IRepositoryOptions) {
    const transaction = SequelizeRepository.getTransaction(options);
    const tenant = SequelizeRepository.getCurrentTenant(options);

    return options.database.visitorLog.count({ where: { ...filter, tenantId: tenant.id }, transaction });
  }

  static async findAndCountAll({ filter, limit = 0, offset = 0, orderBy = '' }, options: IRepositoryOptions) {
    const tenant = SequelizeRepository.getCurrentTenant(options);

    let whereAnd: Array<any> = [];
    let include = [];

    whereAnd.push({ tenantId: tenant.id });
    const assignedAcl = await this._buildAssignedVisitorLogAcl(options);
    if (assignedAcl) {
      if (!assignedAcl.hasAssigned) {
        return { rows: [], count: 0 };
      }
      whereAnd.push(assignedAcl.where);
    }

    if (filter) {
      if (filter.id) {
        whereAnd.push({ ['id']: SequelizeFilterUtils.uuid(filter.id) });
      }

      if (filter.idNumber) {
        whereAnd.push(SequelizeFilterUtils.ilikeIncludes('visitorLog', 'idNumber', filter.idNumber));
      }

      if (filter.lastName) {
        whereAnd.push(SequelizeFilterUtils.ilikeIncludes('visitorLog', 'lastName', filter.lastName));
      }

      if (filter.firstName) {
        whereAnd.push(SequelizeFilterUtils.ilikeIncludes('visitorLog', 'firstName', filter.firstName));
      }

      if (filter.placeType) {
        whereAnd.push(SequelizeFilterUtils.ilikeIncludes('visitorLog', 'placeType', filter.placeType));
      }

      if (filter.stationId || (filter as any).station) {
        // allow filter.station or filter.stationId
        const stationVal = (filter as any).stationId ?? (filter as any).station;
        whereAnd.push({ ['stationId']: SequelizeFilterUtils.uuid(stationVal) });
      }

      // These were sent by the CRM but never applied (staff saw unfiltered results
      // that looked filtered).
      if ((filter as any).clientId) {
        whereAnd.push({ ['clientId']: SequelizeFilterUtils.uuid((filter as any).clientId) });
      }
      if ((filter as any).postSiteId) {
        whereAnd.push({ ['postSiteId']: SequelizeFilterUtils.uuid((filter as any).postSiteId) });
      }
      if ((filter as any).guardId) {
        // the registering guard — createdById holds that user id.
        whereAnd.push({ ['createdById']: SequelizeFilterUtils.uuid((filter as any).guardId) });
      }
      if ((filter as any).tag) {
        whereAnd.push(SequelizeFilterUtils.ilikeIncludes('visitorLog', 'tagNumber', (filter as any).tag));
      }

      // Archive filter: hide archived rows by default; show only archived when
      // explicitly requested (the CRM archived tab sends filter[archived]=true).
      const archivedVal = (filter as any).archived;
      if (archivedVal === true || archivedVal === 'true') {
        whereAnd.push({ archived: true });
      } else if (archivedVal !== 'all') {
        whereAnd.push({ [Op.or]: [{ archived: false }, { archived: null }] });
      }

      // Support a generic text query that searches multiple fields (firstName, lastName, idNumber)
      if ((filter as any).query) {
        const q = (filter as any).query;
        whereAnd.push({
          [Op.or]: [
            SequelizeFilterUtils.ilikeIncludes('visitorLog', 'firstName', q),
            SequelizeFilterUtils.ilikeIncludes('visitorLog', 'lastName', q),
            SequelizeFilterUtils.ilikeIncludes('visitorLog', 'idNumber', q),
          ],
        });
      }

      if (filter.visitDateRange) {
        const [start, end] = filter.visitDateRange;

        if (start !== undefined && start !== null && start !== '') {
          whereAnd.push({ visitDate: { [Op.gte]: start } });
        }

        if (end !== undefined && end !== null && end !== '') {
          whereAnd.push({ visitDate: { [Op.lte]: end } });
        }
      }
      
      if (filter.exitTimeRange) {
        const [start, end] = filter.exitTimeRange;

        if (start !== undefined && start !== null && start !== '') {
          whereAnd.push({ exitTime: { [Op.gte]: start } });
        }

        if (end !== undefined && end !== null && end !== '') {
          whereAnd.push({ exitTime: { [Op.lte]: end } });
        }
      }
    }

    const where = { [Op.and]: whereAnd };

    let { rows, count } = await options.database.visitorLog.findAndCountAll({
      where,
      include,
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
      order: orderBy ? [orderBy.split('_')] : [['createdAt', 'DESC']],
      transaction: SequelizeRepository.getTransaction(options),
    });

    rows = await this._fillWithRelationsAndFilesForRows(rows, options);

    return { rows, count };
  }

  static async findAllAutocomplete(query, limit, options: IRepositoryOptions) {
    const tenant = SequelizeRepository.getCurrentTenant(options);

    let whereAnd: Array<any> = [{ tenantId: tenant.id }];

    if (query) {
      whereAnd.push({ [Op.or]: [{ ['id']: SequelizeFilterUtils.uuid(query) }] });
    }

    const assignedAcl = await this._buildAssignedVisitorLogAcl(options);
    if (assignedAcl && !assignedAcl.hasAssigned) {
      return [];
    }

    if (assignedAcl && assignedAcl.where) {
      whereAnd.push(assignedAcl.where);
    }

    const where = { [Op.and]: whereAnd };

    const records = await options.database.visitorLog.findAll({
      attributes: ['id', 'id'],
      where,
      limit: limit ? Number(limit) : undefined,
      order: [['id', 'ASC']],
    });

    return records.map((record) => ({ id: record.id, label: record.id }));
  }

  static async _createAuditLog(action, record, data, options: IRepositoryOptions) {
    let values = {};

    if (data) {
      values = { ...record.get({ plain: true }) };
    }

    await AuditLogRepository.log({ entityName: 'visitorLog', entityId: record.id, action, values }, options);
  }

  static async _fillWithRelationsAndFilesForRows(rows, options: IRepositoryOptions) {
    if (!rows) return rows;

    return Promise.all(rows.map((record) => this._fillWithRelationsAndFiles(record, options)));
  }

  static async _fillWithRelationsAndFiles(record, options: IRepositoryOptions) {
    if (!record) return record;

    const output = record.get({ plain: true });

    // Attach files for idPhoto
    const files = await options.database.file.findAll({
      where: {
        belongsTo: 'visitorLog',
        belongsToId: record.id,
        belongsToColumn: 'idPhoto',
      },
    });

    output.idPhoto = await FileRepository.fillDownloadUrl(files);

    // Attach files for facePhoto
    const faceFiles = await options.database.file.findAll({
      where: {
        belongsTo: 'visitorLog',
        belongsToId: record.id,
        belongsToColumn: 'facePhoto',
      },
    });

    output.facePhoto = await FileRepository.fillDownloadUrl(faceFiles);

    // Attach client information if present
    if (output.clientId) {
      try {
        const client = await options.database.clientAccount.findByPk(
          output.clientId,
        );
        output.client = client ? client.get({ plain: true }) : null;
      } catch (err) {
        output.client = null;
      }
    }

    // Attach postSite information if present
    if (output.postSiteId) {
      try {
        const postSite = await options.database.businessInfo.findByPk(
          output.postSiteId,
        );
        output.postSite = postSite ? postSite.get({ plain: true }) : null;
      } catch (err) {
        output.postSite = null;
      }
    }

    // Attach station information if present
    if (output.stationId) {
      try {
        const station = await options.database.station.findByPk(
          output.stationId,
        );
        output.station = station ? station.get({ plain: true }) : null;
      } catch (err) {
        output.station = null;
      }
    }

    return output;
  }
}

export default VisitorLogRepository;
