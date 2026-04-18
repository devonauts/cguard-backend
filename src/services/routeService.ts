import Error400 from '../errors/Error400';
import SequelizeRepository from '../database/repositories/sequelizeRepository';
import { IServiceOptions } from './IServiceOptions';
import RouteRepository from '../database/repositories/routeRepository';
import PatrolRepository from '../database/repositories/patrolRepository';
import PatrolCheckpointRepository from '../database/repositories/patrolCheckpointRepository';

export default class RouteService {
  options: IServiceOptions;

  constructor(options) {
    this.options = options;
  }

  async create(data) {
    const transaction = await SequelizeRepository.createTransaction(this.options.database);

    try {
      const record = await RouteRepository.create(data, { ...this.options, transaction });

      // Optionally create a patrol instance from the route template
      // If caller passes `createPatrol: true` and the route has points,
      // attempt to resolve a `station` by matching `postSiteId` to the first point.siteId
      try {
        // createPatrol defaults to true; only skip when explicitly false
        if (data && (data.createPatrol !== false) && Array.isArray(data.points) && data.points.length) {
          const tenant = SequelizeRepository.getCurrentTenant(this.options);
          const firstSiteId = data.points[0].siteId;
          if (firstSiteId) {
            // find station that references this postSiteId
            const station = await this.options.database.station.findOne({
              where: { postSiteId: firstSiteId, tenantId: tenant.id },
              transaction,
            });

            if (station) {
              const patrolData: any = {
                scheduledTime: data.windowStart || new Date(),
                assignedGuard: data.assignedGuard || data.supervisorId || null,
                station: station.id,
              };

              // create patrol checkpoints from route_points
              const routePoints = await this.options.database.routePoint.findAll({
                where: { routeId: record.id },
                order: [['order', 'ASC']],
                transaction,
              });

              const checkpointIds: string[] = [];
              for (const rp of routePoints) {
                try {
                  const cpData: any = {
                    name: rp.address || `Punto ${rp.order}`,
                    latitud: rp.lat != null ? String(rp.lat) : null,
                    longitud: rp.lng != null ? String(rp.lng) : null,
                    station: station.id,
                  };
                  const cp = await PatrolCheckpointRepository.create(cpData, { ...this.options, transaction });
                  if (cp && cp.id) checkpointIds.push(cp.id);
                } catch (e) {
                  // don't fail entire flow if a checkpoint fails; log and continue
                  // eslint-disable-next-line no-console
                  console.warn('RouteService: failed creating patrolCheckpoint for routePoint', rp && rp.id, e);
                }
              }

              if (checkpointIds.length) {
                patrolData.checkpoints = checkpointIds;
              }

              // create patrol within same transaction (will set checkpoints association)
              await PatrolRepository.create(patrolData, { ...this.options, transaction });
            }
          }
        }
      } catch (err) {
        // don't block route creation if patrol creation fails; log for debugging
        // eslint-disable-next-line no-console
        console.warn('RouteService: failed creating patrol from route', err);
      }

      await SequelizeRepository.commitTransaction(transaction);

      return record;
    } catch (error) {
      await SequelizeRepository.rollbackTransaction(transaction);

      SequelizeRepository.handleUniqueFieldError(error, this.options.language, 'route');
      throw error;
    }
  }

  async update(id, data) {
    const transaction = await SequelizeRepository.createTransaction(this.options.database);

    try {
      const record = await RouteRepository.update(id, data, { ...this.options, transaction });

      await SequelizeRepository.commitTransaction(transaction);

      return record;
    } catch (error) {
      await SequelizeRepository.rollbackTransaction(transaction);

      SequelizeRepository.handleUniqueFieldError(error, this.options.language, 'route');
      throw error;
    }
  }

  async destroyAll(ids) {
    const transaction = await SequelizeRepository.createTransaction(this.options.database);
    try {
      for (const id of ids) {
        await RouteRepository.destroy(id, { ...this.options, transaction });
      }
      await SequelizeRepository.commitTransaction(transaction);
    } catch (error) {
      await SequelizeRepository.rollbackTransaction(transaction);
      throw error;
    }
  }

  async findById(id) {
    return RouteRepository.findById(id, this.options);
  }

  async findAllAutocomplete(search, limit) {
    return RouteRepository.findAllAutocomplete(search, limit, this.options);
  }

  async findAndCountAll(args) {
    return RouteRepository.findAndCountAll(args, this.options);
  }

  async import(data, importHash) {
    if (!importHash) {
      throw new Error400(this.options.language, 'importer.errors.importHashRequired');
    }

    if (await this._isImportHashExistent(importHash)) {
      throw new Error400(this.options.language, 'importer.errors.importHashExistent');
    }

    const dataToCreate = { ...data, importHash };
    return this.create(dataToCreate);
  }

  async _isImportHashExistent(importHash) {
    const count = await RouteRepository.count({ importHash }, this.options);
    return count > 0;
  }
}
