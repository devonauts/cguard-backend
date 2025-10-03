import Error400 from '../errors/Error400';
import SequelizeRepository from '../database/repositories/sequelizeRepository';
import { IServiceOptions } from './IServiceOptions';
import RepresentanteEmpresaRepository from '../database/repositories/representanteEmpresaRepository';
import ClientAccountRepository from '../database/repositories/clientAccountRepository';
import UserRepository from '../database/repositories/userRepository';

export default class RepresentanteEmpresaService {
  options: IServiceOptions;

  constructor(options) {
    this.options = options;
  }

  async create(data) {
    const transaction = await SequelizeRepository.createTransaction(
      this.options.database,
    );

    try {
      data.personInCharge = await UserRepository.filterIdInTenant(data.personInCharge, { ...this.options, transaction });
      data.assignedCompany = await ClientAccountRepository.filterIdInTenant(data.assignedCompany, { ...this.options, transaction });

      const record = await RepresentanteEmpresaRepository.create(data, {
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
        'representanteEmpresa',
      );

      throw error;
    }
  }

  async update(id, data) {
    const transaction = await SequelizeRepository.createTransaction(
      this.options.database,
    );

    try {
      data.personInCharge = await UserRepository.filterIdInTenant(data.personInCharge, { ...this.options, transaction });
      data.assignedCompany = await ClientAccountRepository.filterIdInTenant(data.assignedCompany, { ...this.options, transaction });

      const record = await RepresentanteEmpresaRepository.update(
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
        'representanteEmpresa',
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
        await RepresentanteEmpresaRepository.destroy(id, {
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
    return RepresentanteEmpresaRepository.findById(id, this.options);
  }

  async findAllAutocomplete(search, limit) {
    return RepresentanteEmpresaRepository.findAllAutocomplete(
      search,
      limit,
      this.options,
    );
  }

  async findAndCountAll(args) {
    return RepresentanteEmpresaRepository.findAndCountAll(
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
    const count = await RepresentanteEmpresaRepository.count(
      {
        importHash,
      },
      this.options,
    );

    return count > 0;
  }
}
