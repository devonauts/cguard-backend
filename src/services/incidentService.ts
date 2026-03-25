import Error400 from '../errors/Error400';
import SequelizeRepository from '../database/repositories/sequelizeRepository';
import { IServiceOptions } from './IServiceOptions';
import IncidentRepository from '../database/repositories/incidentRepository';
import StationRepository from '../database/repositories/stationRepository';
import IncidentTypeRepository from '../database/repositories/incidentTypeRepository';
import ClientAccountRepository from '../database/repositories/clientAccountRepository';
import BusinessInfoRepository from '../database/repositories/businessInfoRepository';
import SecurityGuardRepository from '../database/repositories/securityGuardRepository';

export default class IncidentService {
  options: IServiceOptions;

  constructor(options) {
    this.options = options;
  }

  async create(data) {
    const transaction = await SequelizeRepository.createTransaction(
      this.options.database,
    );

    try {
      // Normalize alternative field names coming from frontend forms
      if (data) {
        // frontend may send `incidentTypeId` or `incidentType`
        data.incidentType = data.incidentType || data.incidentTypeId || null;
        // frontend may send `guardId` for guard selection
        data.guardNameId = data.guardNameId || data.guardId || null;
        // frontend may send `postSiteId` or `postSite`
        data.postSiteId = data.postSiteId || data.postSite || data.siteId || null;
      }
      // Debug: log incoming payload for troubleshooting guard persistence
      try {
        // eslint-disable-next-line no-console
        console.debug('[IncidentService] create: normalized payload before filtering', {
          guardId: data.guardId,
          guardNameId: data.guardNameId,
          postSiteId: data.postSiteId,
          siteId: data.siteId,
        });
      } catch (e) {
        // ignore logging errors
      }
      data.stationIncidents = await StationRepository.filterIdInTenant(data.stationIncidents, { ...this.options, transaction });
      data.incidentType = await IncidentTypeRepository.filterIdInTenant(data.incidentType, { ...this.options, transaction });
      data.clientId = await ClientAccountRepository.filterIdInTenant(data.clientId, { ...this.options, transaction });
      data.siteId = await BusinessInfoRepository.filterIdInTenant(data.siteId, { ...this.options, transaction });
      // support both siteId and postSiteId naming coming from frontend
      data.postSiteId = await BusinessInfoRepository.filterIdInTenant(data.postSiteId || data.postSite, { ...this.options, transaction });
      data.stationId = await StationRepository.filterIdInTenant(data.stationId, { ...this.options, transaction });
      data.guardNameId = await SecurityGuardRepository.filterIdInTenant(data.guardNameId, { ...this.options, transaction });

      try {
        // eslint-disable-next-line no-console
        console.debug('[IncidentService] create: resolved guardNameId after filter', { guardNameId: data.guardNameId });
      } catch (e) {
        // ignore
      }
      // Ensure required model fields have sensible defaults when frontend omits them
      // `date` is required by model: prefer explicit `date`, then `incidentAt`, otherwise now
      if (!data.date) {
        if (data.incidentAt) data.date = data.incidentAt;
        else data.date = new Date().toISOString();
      }

      // `title` is required by model: prefer explicit title, then subject, fallback to trimmed content
      if (!data.title) {
        if (data.subject) data.title = String(data.subject).slice(0, 255);
        else if (data.content) data.title = String(data.content).slice(0, 255);
        else data.title = `Incidente ${new Date().toISOString()}`.slice(0, 255);
      }

      // `description` is required by model: prefer explicit description, then content/incidentDetails/subject
      if (!data.description) {
        if (data.content) data.description = String(data.content).slice(0, 2500);
        else if (data.incidentDetails) data.description = String(data.incidentDetails).slice(0, 2500);
        else if (data.subject) data.description = String(data.subject).slice(0, 2500);
        else data.description = 'Sin descripción';
      }

      const record = await IncidentRepository.create(data, {
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
        'incident',
      );

      throw error;
    }
  }

  async update(id, data) {
    const transaction = await SequelizeRepository.createTransaction(
      this.options.database,
    );

    try {
      if (data) {
        data.incidentType = data.incidentType || data.incidentTypeId || null;
        data.guardNameId = data.guardNameId || data.guardId || null;
        data.postSiteId = data.postSiteId || data.postSite || data.siteId || null;
      }
      data.stationIncidents = await StationRepository.filterIdInTenant(data.stationIncidents, { ...this.options, transaction });
      data.incidentType = await IncidentTypeRepository.filterIdInTenant(data.incidentType, { ...this.options, transaction });
      data.clientId = await ClientAccountRepository.filterIdInTenant(data.clientId, { ...this.options, transaction });
      data.siteId = await BusinessInfoRepository.filterIdInTenant(data.siteId, { ...this.options, transaction });
      data.postSiteId = await BusinessInfoRepository.filterIdInTenant(data.postSiteId || data.postSite, { ...this.options, transaction });
      data.stationId = await StationRepository.filterIdInTenant(data.stationId, { ...this.options, transaction });
      data.guardNameId = await SecurityGuardRepository.filterIdInTenant(data.guardNameId, { ...this.options, transaction });

      const record = await IncidentRepository.update(
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
        'incident',
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
        await IncidentRepository.destroy(id, {
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
    return IncidentRepository.findById(id, this.options);
  }

  async findAllAutocomplete(search, limit) {
    return IncidentRepository.findAllAutocomplete(
      search,
      limit,
      this.options,
    );
  }

  async findAndCountAll(args) {
    return IncidentRepository.findAndCountAll(
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
    const count = await IncidentRepository.count(
      {
        importHash,
      },
      this.options,
    );

    return count > 0;
  }
}
