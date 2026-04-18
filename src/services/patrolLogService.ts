import Error400 from '../errors/Error400';
import SequelizeRepository from '../database/repositories/sequelizeRepository';
import { IServiceOptions } from './IServiceOptions';
import PatrolLogRepository from '../database/repositories/patrolLogRepository';
import PatrolRepository from '../database/repositories/patrolRepository';
import UserRepository from '../database/repositories/userRepository';

export default class PatrolLogService {
  options: IServiceOptions;

  constructor(options) {
    this.options = options;
  }

  async create(data) {
    const transaction = await SequelizeRepository.createTransaction(
      this.options.database,
    );

    try {
      data.patrol = await PatrolRepository.filterIdInTenant(data.patrol, { ...this.options, transaction });
      data.scannedBy = await UserRepository.filterIdInTenant(data.scannedBy, { ...this.options, transaction });

      // If latitude/longitude provided, attempt to validate proximity to patrol checkpoints
      try {
        if (data.patrol && data.latitude && data.longitude) {
          const tenant = SequelizeRepository.getCurrentTenant(this.options);
          // load patrol with checkpoints
          const patrol = await this.options.database.patrol.findOne({
            where: { id: data.patrol, tenantId: tenant.id },
            include: [{ model: this.options.database.patrolCheckpoint, as: 'checkpoints' }],
            transaction,
          });

          if (patrol && Array.isArray(patrol.checkpoints) && patrol.checkpoints.length) {
            const toNumber = (v) => {
              if (v == null) return null;
              const s = String(v).replace(/,/g, '.');
              const n = Number(s);
              return Number.isFinite(n) ? n : null;
            };

            const lat = toNumber(data.latitude);
            const lng = toNumber(data.longitude);

            if (lat != null && lng != null) {
              // haversine distance (meters)
              const haversine = (lat1, lon1, lat2, lon2) => {
                const toRad = (deg) => (deg * Math.PI) / 180;
                const R = 6371000; // meters
                const dLat = toRad(lat2 - lat1);
                const dLon = toRad(lon2 - lon1);
                const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
                const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
                return R * c;
              };

              let nearest = null;
              let nearestDist = Infinity;
              for (const cp of patrol.checkpoints) {
                const cplat = toNumber(cp.latitud || cp.latitude || cp.lat);
                const cplng = toNumber(cp.longitud || cp.longitude || cp.lng);
                if (cplat == null || cplng == null) continue;
                const d = haversine(lat, lng, cplat, cplng);
                if (d < nearestDist) {
                  nearestDist = d;
                  nearest = cp;
                }
              }

              // threshold meters (configurable) — 100m default
              const threshold = (data.proximityThresholdMeters && Number(data.proximityThresholdMeters)) || 100;
              if (nearest && nearestDist <= threshold) {
                data.validLocation = true;
                data.status = 'Scanned';
              } else {
                data.validLocation = false;
                data.status = 'Missed';
              }
            }
          }
        }
      } catch (e) {
        // do not block creation on proximity calc failures; default to provided values
        // eslint-disable-next-line no-console
        console.warn('patrolLogService: proximity validation failed', e);
      }

      const record = await PatrolLogRepository.create(data, {
        ...this.options,
        transaction,
      });

      await SequelizeRepository.commitTransaction(
        transaction,
      );

      return record;
    } catch (error) {
      await SequelizeRepository.rollbackTransaction(
        transaction,
      );

      SequelizeRepository.handleUniqueFieldError(
        error,
        this.options.language,
        'patrolLog',
      );

      throw error;
    }
  }

  async update(id, data) {
    const transaction = await SequelizeRepository.createTransaction(
      this.options.database,
    );

    try {
      data.patrol = await PatrolRepository.filterIdInTenant(data.patrol, { ...this.options, transaction });
      data.scannedBy = await UserRepository.filterIdInTenant(data.scannedBy, { ...this.options, transaction });

      const record = await PatrolLogRepository.update(
        id,
        data,
        {
          ...this.options,
          transaction,
        },
      );

      await SequelizeRepository.commitTransaction(
        transaction,
      );

      return record;
    } catch (error) {
      await SequelizeRepository.rollbackTransaction(
        transaction,
      );

      SequelizeRepository.handleUniqueFieldError(
        error,
        this.options.language,
        'patrolLog',
      );

      throw error;
    }
  }

  async destroyAll(ids) {
    const transaction = await SequelizeRepository.createTransaction(
      this.options.database,
    );

    try {
      for (const id of ids) {
        await PatrolLogRepository.destroy(id, {
          ...this.options,
          transaction,
        });
      }

      await SequelizeRepository.commitTransaction(
        transaction,
      );
    } catch (error) {
      await SequelizeRepository.rollbackTransaction(
        transaction,
      );
      throw error;
    }
  }

  async findById(id) {
    return PatrolLogRepository.findById(id, this.options);
  }

  async findAllAutocomplete(search, limit) {
    return PatrolLogRepository.findAllAutocomplete(
      search,
      limit,
      this.options,
    );
  }

  async findAndCountAll(args) {
    return PatrolLogRepository.findAndCountAll(
      args,
      this.options,
    );
  }

  async import(data, importHash) {
    if (!importHash) {
      throw new Error400(
        this.options.language,
        'importer.errors.importHashRequired',
      );
    }

    if (await this._isImportHashExistent(importHash)) {
      throw new Error400(
        this.options.language,
        'importer.errors.importHashExistent',
      );
    }

    const dataToCreate = {
      ...data,
      importHash,
    };

    return this.create(dataToCreate);
  }

  async _isImportHashExistent(importHash) {
    const count = await PatrolLogRepository.count(
      {
        importHash,
      },
      this.options,
    );

    return count > 0;
  }
}
