import Error400 from '../errors/Error400';
import SequelizeRepository from '../database/repositories/sequelizeRepository';
import { IServiceOptions } from './IServiceOptions';
import RequestRepository from '../database/repositories/requestRepository';
import SecurityGuardRepository from '../database/repositories/securityGuardRepository';
import ClientAccountRepository from '../database/repositories/clientAccountRepository';
import BusinessInfoRepository from '../database/repositories/businessInfoRepository';
import IncidentTypeRepository from '../database/repositories/incidentTypeRepository';

export default class RequestService {
  options: IServiceOptions;

  constructor(options) {
    this.options = options;
  }

  async create(data) {
    const transaction = await SequelizeRepository.createTransaction(
      this.options.database,
    );

    try {
      // Normalize guard id: frontend sends `guardId`; ensure we filter that id in-tenant
      data.guardId = await SecurityGuardRepository.filterIdInTenant(data.guardId || data.guardName, { ...this.options, transaction });
      data.clientId = await ClientAccountRepository.filterIdInTenant(data.clientId, { ...this.options, transaction });
      data.siteId = await BusinessInfoRepository.filterIdInTenant(data.siteId, { ...this.options, transaction });
      data.incidentTypeId = await IncidentTypeRepository.filterIdInTenant(data.incidentTypeId, { ...this.options, transaction });

      const record = await RequestRepository.create(data, {
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
        'request',
      );

      throw error;
    }
  }

  async update(id, data) {
    const transaction = await SequelizeRepository.createTransaction(
      this.options.database,
    );

    try {
      // Normalize guard id for updates as well
      data.guardId = await SecurityGuardRepository.filterIdInTenant(data.guardId || data.guardName, { ...this.options, transaction });
      data.clientId = await ClientAccountRepository.filterIdInTenant(data.clientId, { ...this.options, transaction });
      data.siteId = await BusinessInfoRepository.filterIdInTenant(data.siteId, { ...this.options, transaction });
      data.incidentTypeId = await IncidentTypeRepository.filterIdInTenant(data.incidentTypeId, { ...this.options, transaction });

      const record = await RequestRepository.update(
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
        'request',
      );

      throw error;
    }
  }

  async patch(id, data) {
    const transaction = await SequelizeRepository.createTransaction(
      this.options.database,
    );

    try {
      // Normalize ids only if provided in the patch payload
      if (Object.prototype.hasOwnProperty.call(data, 'guardId') || Object.prototype.hasOwnProperty.call(data, 'guardName')) {
        data.guardId = await SecurityGuardRepository.filterIdInTenant(data.guardId || data.guardName, { ...this.options, transaction });
      }

      if (Object.prototype.hasOwnProperty.call(data, 'clientId')) {
        data.clientId = await ClientAccountRepository.filterIdInTenant(data.clientId, { ...this.options, transaction });
      }

      if (Object.prototype.hasOwnProperty.call(data, 'siteId')) {
        data.siteId = await BusinessInfoRepository.filterIdInTenant(data.siteId, { ...this.options, transaction });
      }

      if (Object.prototype.hasOwnProperty.call(data, 'incidentTypeId')) {
        data.incidentTypeId = await IncidentTypeRepository.filterIdInTenant(data.incidentTypeId, { ...this.options, transaction });
      }

      const record = await RequestRepository.patch(
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
        'request',
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
        await RequestRepository.destroy(id, {
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
    return RequestRepository.findById(id, this.options);
  }

  async findAllAutocomplete(search, limit) {
    return RequestRepository.findAllAutocomplete(
      search,
      limit,
      this.options,
    );
  }

  async findAndCountAll(args) {
    // Normalize args: controller may pass query params at top-level
    const filter = args.filter || {};

    // Support top-level query and status keys passed as query params
    if (args.query) {
      filter.query = args.query;
    }

    if (args.status) {
      filter.status = args.status;
    }

    const limit = args.limit || args.size || 0;
    const offset = args.offset || 0;
    const orderBy = args.orderBy || '';

    return RequestRepository.findAndCountAll(
      { filter, limit, offset, orderBy },
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
    const count = await RequestRepository.count(
      {
        importHash,
      },
      this.options,
    );

    return count > 0;
  }
}
