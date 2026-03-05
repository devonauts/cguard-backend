import SequelizeRepository from '../database/repositories/sequelizeRepository';
import { IServiceOptions } from './IServiceOptions';

export default class SiteTourService {
  options: IServiceOptions;

  constructor(options) {
    this.options = options;
  }

  async findById(id) {
    const transaction = SequelizeRepository.getTransaction(this.options);
    const record = await this.options.database.siteTour.findOne({ where: { id }, include: ['tags'], transaction });
    if (!record) {
      throw new Error('Not found');
    }
    return record;
  }

  async assignGuard(tourId, guardId, payload = {}) {
    const transaction = await SequelizeRepository.createTransaction(this.options.database);
    try {
      const assignment = await this.options.database.tourAssignment.create({
        siteTourId: tourId,
        securityGuardId: guardId,
        startAt: payload.startAt || null,
        endAt: payload.endAt || null,
        status: payload.status || 'assigned',
      }, { transaction });

      await SequelizeRepository.commitTransaction(transaction);
      return assignment;
    } catch (err) {
      await SequelizeRepository.rollbackTransaction(transaction);
      throw err;
    }
  }

  /**
   * Record a tag scan coming from a guard device.
   * Attempts to find the SiteTourTag by `tagIdentifier` and the active assignment for the guard.
   */
  async recordTagScan({ tagIdentifier, securityGuardId, latitude, longitude, scannedData }) {
    const transaction = await SequelizeRepository.createTransaction(this.options.database);
    try {
      const tag = await this.options.database.siteTourTag.findOne({ where: { tagIdentifier }, transaction });
      if (!tag) {
        const err: any = new Error('Tag not found');
        err.code = 404;
        throw err;
      }

      // Find active assignment for this guard and tour
      const assignment = await this.options.database.tourAssignment.findOne({
        where: {
          securityGuardId,
          siteTourId: tag.siteTourId,
          status: 'assigned',
        },
        transaction,
      });

      // Create tagScan row
      const scan = await this.options.database.tagScan.create({
        siteTourTagId: tag.id,
        tourAssignmentId: assignment ? assignment.id : null,
        securityGuardId,
        scannedAt: new Date(),
        scannedData: { latitude, longitude, extra: scannedData },
      }, { transaction });

      // Optionally update assignment progress or status here

      await SequelizeRepository.commitTransaction(transaction);
      return { tag, assignment, scan };
    } catch (err) {
      await SequelizeRepository.rollbackTransaction(transaction);
      throw err;
    }
  }
}
