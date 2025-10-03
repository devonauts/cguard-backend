import Error400 from '../errors/Error400';
import SequelizeRepository from '../database/repositories/sequelizeRepository';
import { IServiceOptions } from './IServiceOptions';
import ClientAccountRepository from '../database/repositories/clientAccountRepository';
import ServiceRepository from '../database/repositories/serviceRepository';
import StationRepository from '../database/repositories/stationRepository';
import BillingRepository from '../database/repositories/billingRepository';
import NotificationRecipientRepository from '../database/repositories/notificationRecipientRepository';
import UserRepository from '../database/repositories/userRepository';

export default class ClientAccountService {
  options: IServiceOptions;

  constructor(options) {
    this.options = options;
  }

  async create(data) {
    const transaction = await SequelizeRepository.createTransaction(
      this.options.database,
    );

    try {
      data.representante = await UserRepository.filterIdInTenant(data.representante, { ...this.options, transaction });
      data.purchasedServices = await ServiceRepository.filterIdsInTenant(data.purchasedServices, { ...this.options, transaction });
      data.stations = await StationRepository.filterIdsInTenant(data.stations, { ...this.options, transaction });
      data.billingInvoices = await BillingRepository.filterIdsInTenant(data.billingInvoices, { ...this.options, transaction });
      data.pushNotifications = await NotificationRecipientRepository.filterIdsInTenant(data.pushNotifications, { ...this.options, transaction });

      const record = await ClientAccountRepository.create(data, {
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
        'clientAccount',
      );

      throw error;
    }
  }

  async update(id, data) {
    const transaction = await SequelizeRepository.createTransaction(
      this.options.database,
    );

    try {
      data.representante = await UserRepository.filterIdInTenant(data.representante, { ...this.options, transaction });
      data.purchasedServices = await ServiceRepository.filterIdsInTenant(data.purchasedServices, { ...this.options, transaction });
      data.stations = await StationRepository.filterIdsInTenant(data.stations, { ...this.options, transaction });
      data.billingInvoices = await BillingRepository.filterIdsInTenant(data.billingInvoices, { ...this.options, transaction });
      data.pushNotifications = await NotificationRecipientRepository.filterIdsInTenant(data.pushNotifications, { ...this.options, transaction });

      const record = await ClientAccountRepository.update(
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
        'clientAccount',
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
        await ClientAccountRepository.destroy(id, {
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
    return ClientAccountRepository.findById(id, this.options);
  }

  async findAllAutocomplete(search, limit) {
    return ClientAccountRepository.findAllAutocomplete(
      search,
      limit,
      this.options,
    );
  }

  async findAndCountAll(args) {
    return ClientAccountRepository.findAndCountAll(
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
    const count = await ClientAccountRepository.count(
      {
        importHash,
      },
      this.options,
    );

    return count > 0;
  }
}
