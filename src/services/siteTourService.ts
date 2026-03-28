import SequelizeRepository from '../database/repositories/sequelizeRepository';
import { IServiceOptions } from './IServiceOptions';

export default class SiteTourService {
  options: IServiceOptions;

  constructor(options) {
    this.options = options;
  }

  async findById(id: string) {
    const transaction = SequelizeRepository.getTransaction(this.options);
    const record = await this.options.database.siteTour.findOne({ where: { id }, include: ['tags'], transaction });
    if (!record) {
      throw new Error('Not found');
    }
    return record;
  }

  async assignGuard(
    tourId: string,
    guardId: string,
    payload: {
      startAt?: string | Date | null;
      endAt?: string | Date | null;
      status?: string;
      stationId?: string | null;
      postSiteId?: string | null;
    } = {},
  ) {
    const transaction = await SequelizeRepository.createTransaction(this.options.database);
    try {
      const assignment = await this.options.database.tourAssignment.create({
        siteTourId: tourId,
        securityGuardId: guardId,
        startAt: payload.startAt ?? null,
        endAt: payload.endAt ?? null,
        status: payload.status ?? 'assigned',
        stationId: payload.stationId ?? null,
        postSiteId: payload.postSiteId ?? null,
        tenantId: this.options.currentTenant ? this.options.currentTenant.id : null,
        createdById: this.options.currentUser ? this.options.currentUser.id : null,
        updatedById: this.options.currentUser ? this.options.currentUser.id : null,
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

      // Ensure assignment has tenantId when request provides currentTenant
      if (assignment && this.options.currentTenant && this.options.currentTenant.id && !assignment.tenantId) {
        // update assignment tenantId so table reflects tenant ownership
        await assignment.update({ tenantId: this.options.currentTenant.id }, { transaction });
      }

      // If we have an assignment, ensure idempotency: don't double-count same tag for the same assignment
      let scan = null;
      if (assignment) {
        const existing = await this.options.database.tagScan.findOne({
          where: {
            tourAssignmentId: assignment.id,
            siteTourTagId: tag.id,
          },
          transaction,
        });
        if (existing) {
          // already scanned this tag for this assignment — return without incrementing
          await SequelizeRepository.commitTransaction(transaction);
          return { tag, assignment, scan: existing };
        }
      }

      // Create tagScan row
      scan = await this.options.database.tagScan.create({
        siteTourTagId: tag.id,
        tourAssignmentId: assignment ? assignment.id : null,
        securityGuardId,
        scannedAt: new Date(),
        scannedData: { latitude, longitude, extra: scannedData },
      }, { transaction });

      // If assignment exists, increment scansCompleted and mark completed when reaching total tags
      if (assignment) {
        // increment atomically
        await assignment.increment('scansCompleted', { by: 1, transaction });

        // get current scansCompleted value
        await assignment.reload({ transaction });

        // count total tags for the tour
        const totalTags = await this.options.database.siteTourTag.count({ where: { siteTourId: tag.siteTourId }, transaction });

        if ((assignment as any).scansCompleted >= totalTags) {
          await assignment.update({ status: 'completed', completedAt: new Date() }, { transaction });
        }
      }

      await SequelizeRepository.commitTransaction(transaction);
      return { tag, assignment, scan };
    } catch (err) {
      await SequelizeRepository.rollbackTransaction(transaction);
      throw err;
    }
  }

  async listAssignments(tourId: string) {
    const transaction = SequelizeRepository.getTransaction(this.options);
    const where: any = { siteTourId: tourId };
    if (this.options.currentTenant && this.options.currentTenant.id) {
      where.tenantId = this.options.currentTenant.id;
    }
    const rows = await this.options.database.tourAssignment.findAll({ where, transaction });
    return rows;
  }

  async getAssignment(assignmentId: string) {
    const transaction = SequelizeRepository.getTransaction(this.options);
    const where: any = { id: assignmentId };
    if (this.options.currentTenant && this.options.currentTenant.id) where.tenantId = this.options.currentTenant.id;
    const record = await this.options.database.tourAssignment.findOne({ where, transaction });
    if (!record) {
      const err: any = new Error('Not found'); err.code = 404; throw err;
    }
    return record;
  }

  async updateAssignment(assignmentId: string, data: any) {
    const transaction = await SequelizeRepository.createTransaction(this.options.database);
    try {
      const where: any = { id: assignmentId };
      if (this.options.currentTenant && this.options.currentTenant.id) where.tenantId = this.options.currentTenant.id;
      const record = await this.options.database.tourAssignment.findOne({ where, transaction });
      if (!record) {
        const err: any = new Error('Not found'); err.code = 404; throw err;
      }

      const updateData: any = {};
      // allow updates to these fields
      const allowed = ['startAt', 'endAt', 'status', 'securityGuardId', 'postSiteId', 'stationId', 'importHash'];
      allowed.forEach((k) => {
        if (Object.prototype.hasOwnProperty.call(data, k)) updateData[k] = data[k];
      });
      updateData.updatedById = this.options.currentUser ? this.options.currentUser.id : null;
      await record.update(updateData, { transaction });
      await SequelizeRepository.commitTransaction(transaction);
      return record;
    } catch (err) {
      await SequelizeRepository.rollbackTransaction(transaction);
      throw err;
    }
  }

  async deleteAssignment(assignmentId: string) {
    const transaction = await SequelizeRepository.createTransaction(this.options.database);
    try {
      const where: any = { id: assignmentId };
      if (this.options.currentTenant && this.options.currentTenant.id) where.tenantId = this.options.currentTenant.id;
      const record = await this.options.database.tourAssignment.findOne({ where, transaction });
      if (!record) {
        const err: any = new Error('Not found'); err.code = 404; throw err;
      }
      await record.destroy({ transaction });
      await SequelizeRepository.commitTransaction(transaction);
      return {};
    } catch (err) {
      await SequelizeRepository.rollbackTransaction(transaction);
      throw err;
    }
  }
}
