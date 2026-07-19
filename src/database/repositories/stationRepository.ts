import SequelizeRepository from '../../database/repositories/sequelizeRepository';
import AuditLogRepository from '../../database/repositories/auditLogRepository';
import lodash from 'lodash';
import SequelizeFilterUtils from '../../database/utils/sequelizeFilterUtils';
import Error404 from '../../errors/Error404';
import Sequelize from 'sequelize';import UserRepository from './userRepository';
import { IRepositoryOptions } from './IRepositoryOptions';

const Op = Sequelize.Op;

class StationRepository {

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

    const record = await options.database.station.create(
      {
        ...lodash.pick(data, [
          'stationName',
          'nickname',
          'latitud',
          'longitud',
          'numberOfGuardsInStation',
          'stationSchedule',
          'startingTimeInDay',
          'finishTimeInDay',
          'geofenceRadius',
          'geofencePolygon',
          'clockInEarlyBufferMin',
          'clockInLateGraceMin',
          'isMobile',
          'importHash',
          'postSiteId',
        ]),
        stationOriginId: data.stationOrigin || null,
        postSiteId: data.postSite || data.postSiteId || null,
        tenantId: tenant.id,
        createdById: currentUser.id,
        updatedById: currentUser.id,
      },
      {
        transaction,
      },
    );

    // NOTE: no setAssignedGuards — the stationAssignedGuardsUser pivot is DEAD.
    // Guard↔station assignment lives ONLY in guardAssignment (assignmentService).
    await record.setTasks(data.tasks || [], {
      transaction,
    });
    await record.setReports(data.reports || [], {
      transaction,
    });
    await record.setIncidents(data.incidents || [], {
      transaction,
    });
    await record.setCheckpoints(data.checkpoints || [], {
      transaction,
    });
    await record.setPatrol(data.patrol || [], {
      transaction,
    });
    // (station↔shift M:N removed — Phase 1; shifts link via shift.stationId)

    // ── Herencia de rondas huérfanas (patrón borrar-y-recrear puesto) ─────
    // Si el sitio tiene rondas cuyo puesto fue ELIMINADO y este puesto nuevo
    // es el único activo del sitio, adóptalas automáticamente: los QR ya
    // impresos y el historial siguen vivos en el puesto de reemplazo.
    // (Caso real: Seguridad BAS borró su estación y recreó otra — sus 3 QR
    // "desaparecieron" hasta re-apuntarlos a mano.)
    let adoptedTours = 0;
    try {
      const postSiteId = record.postSiteId;
      if (postSiteId && options.database.siteTour) {
        const Op = options.database.Sequelize.Op;
        const siblingCount = await options.database.station.count({
          where: { tenantId: tenant.id, postSiteId, id: { [Op.ne]: record.id } },
          transaction,
        });
        if (siblingCount === 0) {
          const activeStations = await options.database.station.findAll({
            where: { tenantId: tenant.id },
            attributes: ['id'],
            transaction,
          });
          const activeIds = activeStations.map((s: any) => String(s.id));
          const orphans = await options.database.siteTour.findAll({
            where: { tenantId: tenant.id, postSiteId },
            attributes: ['id', 'stationId'],
            transaction,
          });
          const toAdopt = orphans.filter(
            (tr: any) => tr.stationId && !activeIds.includes(String(tr.stationId)),
          );
          if (toAdopt.length) {
            const tourIds = toAdopt.map((tr: any) => tr.id);
            await options.database.siteTour.update(
              { stationId: record.id },
              { where: { id: { [Op.in]: tourIds } }, transaction },
            );
            if (options.database.tourAssignment) {
              await options.database.tourAssignment.update(
                { stationId: record.id },
                { where: { tenantId: tenant.id, siteTourId: { [Op.in]: tourIds } }, transaction },
              );
            }
            adoptedTours = toAdopt.length;
            console.log(
              `[station] ${adoptedTours} ronda(s) huérfana(s) adoptada(s) por el puesto ${record.id} (sitio ${postSiteId})`,
            );
          }
        }
      }
    } catch (e) {
      console.warn('[station] orphan-tour adoption failed:', (e as any)?.message || e);
    }

    await this._createAuditLog(
      AuditLogRepository.CREATE,
      record,
      data,
      options,
    );

    const created = await this.findById(record.id, options);
    if (created && adoptedTours > 0) {
      (created as any).dataValues
        ? ((created as any).dataValues.adoptedTours = adoptedTours)
        : ((created as any).adoptedTours = adoptedTours);
    }
    return created;
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

    let record = await options.database.station.findOne(      
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

    const updatePayload: any = {
      ...lodash.pick(data, [
        'stationName',
        'nickname',
        'latitud',
        'longitud',
        'numberOfGuardsInStation',
        'stationSchedule',
        'startingTimeInDay',
        'finishTimeInDay',
        'geofenceRadius',
        'geofencePolygon',
        'clockInEarlyBufferMin',
        'clockInLateGraceMin',
        'isMobile',
        'importHash',
      ]),
      updatedById: currentUser.id,
    };
    // Only (re)assign the FK columns when the caller actually sent them — a
    // partial update (e.g. saving only the location/geofence) must NOT null the
    // station's sitio (postSiteId) or origin.
    if (data.stationOrigin !== undefined) updatePayload.stationOriginId = data.stationOrigin || null;
    if (data.postSite !== undefined || data.postSiteId !== undefined) {
      updatePayload.postSiteId = data.postSite || data.postSiteId || null;
    }
    record = await record.update(updatePayload, { transaction });

    // Only re-set an association when the caller actually sent it. A partial
    // update (e.g. the post-site wizard, which only edits station fields) must
    // NOT wipe relations it didn't touch. Critically, setCheckpoints([]) would
    // try to NULL the stationId of this station's existing patrol checkpoints —
    // and patrolCheckpoint.stationId is NOT NULL → "patrolCheckpoint.stationId
    // cannot be null" 400. Guarding on `!== undefined` avoids that and also stops
    // silently clearing assigned guards / tasks / reports / incidents on every edit.
    // NOTE: assignedGuards intentionally NOT written — the pivot is dead; the
    // truth is guardAssignment. Payloads still carrying assignedGuards are ignored.
    if (data.tasks !== undefined) await record.setTasks(data.tasks || [], { transaction });
    if (data.reports !== undefined) await record.setReports(data.reports || [], { transaction });
    if (data.incidents !== undefined) await record.setIncidents(data.incidents || [], { transaction });
    if (data.checkpoints !== undefined) await record.setCheckpoints(data.checkpoints || [], { transaction });
    if (data.patrol !== undefined) await record.setPatrol(data.patrol || [], { transaction });
    // NOTE: no `record.setShift(...)` — the station↔shift M:N association was
    // removed in the Phase-1 cleanup (shifts now reference shift.stationId, a
    // 1:N). The leftover setShift call threw "setShift is not a function" and
    // 500'd every station update (e.g. editing the horario).

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

    let record = await options.database.station.findOne(
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
        model: options.database.clientAccount,
        as: 'stationOrigin',
      },
      {
        model: options.database.businessInfo,
        as: 'postSite',
        required: false,
        // Pull the sede's owning client so the station breadcrumb can render
        // the full Clientes › Cliente › Sede › Estación chain.
        include: [
          {
            model: options.database.clientAccount,
            as: 'clientAccount',
            attributes: ['id', 'name', 'commercialName'],
            required: false,
          },
        ],
      },
      // NOTE: no assignedGuards include — the legacy pivot is DEAD;
      // _fillWithRelationsAndFiles hydrates assignedGuards from guardAssignment.
    ];

    const currentTenant = SequelizeRepository.getCurrentTenant(
      options,
    );

    // Enforce assigned-postsite ACL for non-admin users (customers)
    const currentUser = SequelizeRepository.getCurrentUser(options);
    let isAdmin = false;
    try {
      if (currentUser && currentUser.tenants) {
        const tenantUserRec = currentUser.tenants.find((t) => t.tenant.id === currentTenant.id && t.status === 'active');
        if (tenantUserRec) {
          let roles: any = [];
          if (Array.isArray(tenantUserRec.roles)) roles = tenantUserRec.roles;
          else if (typeof tenantUserRec.roles === 'string') {
            try { roles = JSON.parse(tenantUserRec.roles); } catch (e) { roles = []; }
          }
          isAdmin = roles.includes((await import('../../security/roles')).default.values.admin);
        }
      }
    } catch (e) {
      isAdmin = false;
    }

    if (!isAdmin) {
      // First try tenantUser assigned posts
      const tenantUser = await options.database.tenantUser.findOne({
        where: { tenantId: currentTenant.id, userId: currentUser.id },
        include: [{ model: options.database.businessInfo, as: 'assignedPostSites', attributes: ['id'] }],
        transaction,
      });

      let allowedPostSiteIds = (tenantUser && tenantUser.assignedPostSites && tenantUser.assignedPostSites.map((c) => c.id)) || [];

      // If no assigned posts and user has a clientAccountId (customer), allow posts for that client
      if (!allowedPostSiteIds.length) {
        try {
          const clientAccountId = currentUser && (currentUser as any).clientAccountId;
          if (clientAccountId) {
            const posts = await options.database.businessInfo.findAll({ where: { tenantId: currentTenant.id, clientAccountId }, attributes: ['id'], transaction });
            allowedPostSiteIds = (posts || []).map((p) => p.id).filter(Boolean);
          }
        } catch (e) {
          // ignore
        }
      }

      if (!allowedPostSiteIds.length) {
        throw new Error404();
      }

      const record = await options.database.station.findOne({
        where: {
          id,
          tenantId: currentTenant.id,
          postSiteId: { [Op.in]: allowedPostSiteIds },
        },
        include,
        transaction,
      });

      if (!record) {
        throw new Error404();
      }

      return this._fillWithRelationsAndFiles(record, options);
    }

    const record = await options.database.station.findOne(
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

    const records = await options.database.station.findAll(
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

    return options.database.station.count(
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
        as: 'stationOrigin',
      },      
    ];

    whereAnd.push({
      tenantId: tenant.id,
    });

    if (filter) {
      // Accept either alias — some callers send postSiteId, others postSite.
      const postSiteFilter = filter.postSite || filter.postSiteId;
      if (postSiteFilter) {
        whereAnd.push({ postSiteId: SequelizeFilterUtils.uuid(postSiteFilter) });
      }

      if (filter.id) {
        whereAnd.push({
          ['id']: SequelizeFilterUtils.uuid(filter.id),
        });
      }

      if (filter.stationOrigin) {
        whereAnd.push({
          ['stationOriginId']: SequelizeFilterUtils.uuid(
            filter.stationOrigin,
          ),
        });
      }

      if (filter.stationName) {
        whereAnd.push(
          SequelizeFilterUtils.ilikeIncludes(
            'station',
            'stationName',
            filter.stationName,
          ),
        );
      }

      if (filter.stationSchedule) {
        whereAnd.push({
          stationSchedule: filter.stationSchedule,
        });
      }

      if (filter.startingTimeInDay) {
        whereAnd.push(
          SequelizeFilterUtils.ilikeIncludes(
            'station',
            'startingTimeInDay',
            filter.startingTimeInDay,
          ),
        );
      }

      if (filter.finishTimeInDay) {
        whereAnd.push(
          SequelizeFilterUtils.ilikeIncludes(
            'station',
            'finishTimeInDay',
            filter.finishTimeInDay,
          ),
        );
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


    // If current user is not admin, restrict stations to tenantUser.assignedPostSites
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
          isAdmin = roles.includes((await import('../../security/roles')).default.values.admin);
        }
      }

      if (!isAdmin) {
        const tenantUser = await options.database.tenantUser.findOne({
          where: { tenantId: tenant.id, userId: currentUser.id },
          include: [{ model: options.database.businessInfo, as: 'assignedPostSites', attributes: ['id'] }],
          transaction: SequelizeRepository.getTransaction(options),
        });

        let allowedIds = (tenantUser && tenantUser.assignedPostSites && tenantUser.assignedPostSites.map((c) => c.id)) || [];

        // If not assigned and user has clientAccountId (customer), allow posts for that client
        if (!allowedIds.length) {
          try {
            const clientAccountId = currentUser && (currentUser as any).clientAccountId;
            if (clientAccountId) {
              const posts = await options.database.businessInfo.findAll({ where: { tenantId: tenant.id, clientAccountId }, attributes: ['id'], transaction: SequelizeRepository.getTransaction(options) });
              allowedIds = (posts || []).map((p) => p.id).filter(Boolean);
            }
          } catch (e) {
            // ignore
          }
        }

        if (!allowedIds.length) {
          return { rows: [], count: 0 };
        }

        whereAnd.push({ postSiteId: { [Op.in]: allowedIds } });
      }
    } catch (e) {
      // ignore and proceed without restricting
    }

    const where = { [Op.and]: whereAnd };

    let {
      rows,
      count,
    } = await options.database.station.findAndCountAll({
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

    // LEAN list path. The old per-row _fill ran ~8 queries/row (getAssignedGuards
    // + getTasks/Reports/Incidents/Checkpoints/Patrol + postSite findByPk + a
    // scheduled-shift group) — and the CRM fetches stations with limit=999, i.e.
    // ~8,000 queries for one render. The station list ONLY consumes
    // assignedGuards + guardsCount (+ postSite name); _fillForList computes those
    // in 3 batched queries for ALL rows and drops the unused tasks/reports/
    // incidents/checkpoints/patrol arrays. Full enrichment stays on findById.
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
          {
            [Op.and]: SequelizeFilterUtils.ilikeIncludes(
              'station',
              'stationName',
              query,
            ),
          },
        ],
      });
    }

    const where = { [Op.and]: whereAnd };

    const records = await options.database.station.findAll(
      {
        attributes: ['id', 'stationName'],
        where,
        limit: limit ? Number(limit) : undefined,
        order: [['stationName', 'ASC']],
      },
    );

    return records.map((record) => ({
      id: record.id,
      label: record.stationName,
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
        assignedGuardsIds: data.assignedGuards,
        tasksIds: data.tasks,
        reportsIds: data.reports,
        incidentsIds: data.incidents,
        checkpointsIds: data.checkpoints,
        patrolIds: data.patrol,
        shiftIds: data.shift,
      };
    }

    await AuditLogRepository.log(
      {
        entityName: 'station',
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

  /**
   * LEAN list enricher — same fields the station list consumes (assignedGuards,
   * guardsCount, postSite {id,businessName}), computed in 3 BATCHED queries for
   * all rows instead of ~8 per row. Drops the tasks/reports/incidents/
   * checkpoints/patrol arrays the list never reads. Detail stays on findById.
   */
  static async _fillForList(rows, options: IRepositoryOptions) {
    if (!rows || !rows.length) return rows;
    const tenant = SequelizeRepository.getCurrentTenant(options);
    const transaction = SequelizeRepository.getTransaction(options);

    const outputs = rows.map((r) => r.get({ plain: true }));
    const ids = outputs.map((o) => o.id).filter(Boolean);

    // 1) Assigned guards (guardAssignment — single source of truth; the legacy
    // stationAssignedGuardsUser junction is DEAD and showed ghost guards) for
    // ALL stations in one query.
    const assigns = ids.length
      ? await options.database.guardAssignment.findAll({
          where: { stationId: ids, tenantId: tenant.id, status: 'active' },
          attributes: ['stationId', 'guardId'],
          include: [{
            model: options.database.user,
            as: 'guard',
            attributes: { exclude: ['password', 'emailVerificationToken', 'passwordResetToken', 'importHash'] },
          }],
          transaction,
        }).catch(() => [])
      : [];
    const guardsByStation = new Map<string, any[]>();
    for (const a of assigns) {
      const k = String(a.stationId);
      if (!guardsByStation.has(k)) guardsByStation.set(k, []);
      const list = guardsByStation.get(k)!;
      const u = a.guard && a.guard.get ? a.guard.get({ plain: true }) : a.guard;
      if (u && !list.some((g: any) => String(g.id) === String(u.id))) list.push(u);
    }

    // 2) Distinct guards SCHEDULED FROM NOW ON per station (a guard who worked
    // one shift months ago must not count as staffing forever).
    const scheduled = ids.length
      ? await options.database.shift.findAll({
          where: {
            stationId: ids,
            tenantId: tenant.id,
            guardId: { [Op.ne]: null },
            endTime: { [Op.gte]: new Date() },
          },
          attributes: ['stationId', 'guardId'],
          group: ['stationId', 'guardId'],
          transaction,
        })
      : [];
    const schedByStation = new Map<string, Set<string>>();
    for (const s of scheduled) {
      const k = String(s.stationId);
      if (!schedByStation.has(k)) schedByStation.set(k, new Set());
      if (s.guardId) schedByStation.get(k)!.add(String(s.guardId));
    }

    // 3) Post-site names (only those referenced) in one query.
    const postSiteIds = Array.from(new Set(outputs.map((o) => o.postSiteId).filter(Boolean)));
    const posts = postSiteIds.length
      ? await options.database.businessInfo.findAll({
          where: { id: postSiteIds, tenantId: tenant.id },
          attributes: ['id', 'companyName'],
          transaction,
        })
      : [];
    const postById = new Map(posts.map((p: any) => [String(p.id), p]));

    for (const output of outputs) {
      const sid = String(output.id);
      const assigned = guardsByStation.get(sid) || [];
      output.assignedGuards = UserRepository.cleanupForRelationships(assigned);
      output.assignedGuardsCount = assigned.length;

      const set = new Set(
        (Array.isArray(assigned) ? assigned : []).map((g: any) => g && g.id).filter(Boolean).map(String),
      );
      for (const gid of schedByStation.get(sid) || []) set.add(gid);
      output.scheduledGuardsCount = (schedByStation.get(sid) || new Set()).size;
      output.guardsCount = set.size;

      if (output.postSiteId) {
        const p: any = postById.get(String(output.postSiteId));
        // Preserve the existing {id, businessName} shape (businessName ← companyName).
        output.postSite = p ? { id: p.id, businessName: p.companyName || null } : null;
      }
    }

    return outputs;
  }

  static async _fillWithRelationsAndFiles(record, options: IRepositoryOptions) {
    if (!record) {
      return record;
    }

    const output = record.get({ plain: true });

    const tenant = SequelizeRepository.getCurrentTenant(options);

    const transaction = SequelizeRepository.getTransaction(
      options,
    );

    // Assigned guards from guardAssignment (single source of truth — the
    // legacy getAssignedGuards junction is DEAD and returned ghost guards).
    try {
      const assigns = await options.database.guardAssignment.findAll({
        where: { stationId: record.id, tenantId: tenant.id, status: 'active' },
        attributes: ['guardId'],
        include: [{
          model: options.database.user,
          as: 'guard',
          attributes: { exclude: ['password', 'emailVerificationToken', 'passwordResetToken', 'importHash'] },
        }],
        transaction,
      });
      const seen = new Set<string>();
      output.assignedGuards = [];
      for (const a of assigns) {
        const u = a.guard && a.guard.get ? a.guard.get({ plain: true }) : a.guard;
        if (u && !seen.has(String(u.id))) { seen.add(String(u.id)); output.assignedGuards.push(u); }
      }
    } catch {
      output.assignedGuards = [];
    }

    output.assignedGuards = UserRepository.cleanupForRelationships(output.assignedGuards);

    output.tasks = await record.getTasks({
      transaction,
    });

    output.reports = await record.getReports({
      transaction,
    });

    output.incidents = await record.getIncidents({
      transaction,
    });

    output.checkpoints = await record.getCheckpoints({
      transaction,
    });

    output.patrol = await record.getPatrol({
      transaction,
    });
    // (station.getShift removed — Phase 1; query shifts via shift.stationId)

    // Attach simplified postSite info if available. Keep the owning client
    // (clientAccount) so the station breadcrumb can show Cliente › Sede.
    const slimClient = (ca: any) => (ca ? { id: ca.id, name: ca.name, commercialName: ca.commercialName, companyName: ca.companyName } : null);
    if (output.postSite) {
      // businessInfo's display-name column is companyName (there is no
      // `businessName`/`name` column — this mapping always returned null).
      output.postSite = {
        id: output.postSite.id,
        businessName: output.postSite.companyName || null,
        clientAccountId: output.postSite.clientAccountId || null,
        clientAccount: slimClient(output.postSite.clientAccount),
      };
    } else if (output.postSiteId) {
      // fallback: try to load postSite when only id present
      try {
        const post = await options.database.businessInfo.findOne({
          where: { id: output.postSiteId, tenantId: tenant.id },
          include: [{ model: options.database.clientAccount, as: 'clientAccount', attributes: ['id', 'name', 'commercialName'], required: false }],
          transaction,
        });
        output.postSite = post
          ? { id: post.id, businessName: post.companyName || null, clientAccountId: post.clientAccountId || null, clientAccount: slimClient((post as any).clientAccount) }
          : null;
      } catch (e) {
        output.postSite = null;
      }
    }

    // Expose counts to simplify frontend consumption and avoid recomputing lengths there
    output.assignedGuardsCount = Array.isArray(output.assignedGuards)
      ? output.assignedGuards.length
      : 0;

    output.incidentsCount = Array.isArray(output.incidents)
      ? output.incidents.length
      : 0;

    output.tasksCount = Array.isArray(output.tasks)
      ? output.tasks.length
      : 0;

    // Guards that actually work this station: the explicit assignment junction
    // PLUS distinct guards scheduled via shifts (the operational source of truth
    // shown in Horario). Previously only the (usually empty) junction was counted,
    // so stations with scheduled guards showed "Sin guardias".
    const guardIds = new Set<string>(
      (Array.isArray(output.assignedGuards) ? output.assignedGuards : [])
        .map((g: any) => g && g.id)
        .filter(Boolean),
    );
    try {
      const tenant = SequelizeRepository.getCurrentTenant(options);
      const scheduled = await options.database.shift.findAll({
        where: {
          stationId: record.id,
          ...(tenant && tenant.id ? { tenantId: tenant.id } : {}),
          guardId: { [Op.ne]: null },
          // From NOW on — a guard who worked one shift months ago must not
          // count as current staffing forever.
          endTime: { [Op.gte]: new Date() },
        },
        attributes: ['guardId'],
        group: ['guardId'],
        transaction: SequelizeRepository.getTransaction(options),
      });
      output.scheduledGuardsCount = (scheduled || []).length;
      (scheduled || []).forEach((s: any) => s.guardId && guardIds.add(s.guardId));
    } catch (e) {
      output.scheduledGuardsCount = 0;
    }

    // Total distinct guards working this station (assigned ∪ scheduled).
    output.guardsCount = guardIds.size;

    return output;
  }
}

export default StationRepository;
