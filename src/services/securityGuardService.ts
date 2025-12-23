import Error400 from '../errors/Error400';
import SequelizeRepository from '../database/repositories/sequelizeRepository';
import { IServiceOptions } from './IServiceOptions';
import SecurityGuardRepository from '../database/repositories/securityGuardRepository';
import MemosRepository from '../database/repositories/memosRepository';
import RequestRepository from '../database/repositories/requestRepository';
import CompletionOfTutorialRepository from '../database/repositories/completionOfTutorialRepository';
import UserRepository from '../database/repositories/userRepository';
import bcrypt from 'bcryptjs';

export default class SecurityGuardService {
  options: IServiceOptions;

  constructor(options) {
    this.options = options;
  }

  async create(data) {
    // Si ya existe un guardia con el mismo guardId y tenantId, actualizarlo en vez de crear uno nuevo
    if (data && data.guard) {
      try {
        const existing = await SecurityGuardRepository.findAndCountAll(
          { filter: { guard: data.guard }, limit: 1 },
          this.options,
        );
        if (existing && existing.count > 0) {
          const first = existing.rows && existing.rows[0];
          // Actualiza el guardia existente, sin importar governmentId
          return this.update(first.id, data);
        }
      } catch (err) {
        // ignore lookup errors and proceed to create a new record
      }
    }

    const transaction = await SequelizeRepository.createTransaction(
      this.options.database,
    );

    try {
      data.guard = await UserRepository.filterIdInTenant(data.guard, { ...this.options, transaction });
      data.memos = await MemosRepository.filterIdsInTenant(data.memos, { ...this.options, transaction });
      data.requests = await RequestRepository.filterIdsInTenant(data.requests, { ...this.options, transaction });
      data.tutoriales = await CompletionOfTutorialRepository.filterIdsInTenant(data.tutoriales, { ...this.options, transaction });

      // Si el payload incluye password y email, crea o actualiza el usuario
      if (data.password && data.email) {
        const BCRYPT_SALT_ROUNDS = 12;
        const hashedPassword = await bcrypt.hash(data.password, BCRYPT_SALT_ROUNDS);
        // Buscar usuario por email
        let user = await UserRepository.findByEmail(data.email, { ...this.options, transaction });
        if (user) {
          // Actualizar password y phoneNumber si existe
          await UserRepository.updateProfile(user.id, {
            phoneNumber: data.phoneNumber || data.phone || null,
          }, { ...this.options, transaction });
          await UserRepository.updatePassword(user.id, hashedPassword, false, { ...this.options, transaction, bypassPermissionValidation: true });
        } else {
          // Crear usuario nuevo
          await UserRepository.createFromAuth({
            email: data.email,
            password: hashedPassword,
            firstName: data.firstName || null,
            lastName: data.lastName || null,
            fullName: data.fullName || null,
            phoneNumber: data.phoneNumber || data.phone || null,
            emailVerified: false,
          }, { ...this.options, transaction });
        }
      }

      // Hash password para guardia (si existe)
      if (data.password) {
        const BCRYPT_SALT_ROUNDS = 12;
        data.password = await bcrypt.hash(data.password, BCRYPT_SALT_ROUNDS);
      }

      const record = await SecurityGuardRepository.create(data, {
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
        'securityGuard',
      );

      throw error;
    }
  }

  async update(id, data) {
    const transaction = await SequelizeRepository.createTransaction(
      this.options.database,
    );

    try {
      data.guard = await UserRepository.filterIdInTenant(data.guard, { ...this.options, transaction });
      data.memos = await MemosRepository.filterIdsInTenant(data.memos, { ...this.options, transaction });
      data.requests = await RequestRepository.filterIdsInTenant(data.requests, { ...this.options, transaction });
      data.tutoriales = await CompletionOfTutorialRepository.filterIdsInTenant(data.tutoriales, { ...this.options, transaction });

      const record = await SecurityGuardRepository.update(
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
        'securityGuard',
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
        await SecurityGuardRepository.destroy(id, {
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
    return SecurityGuardRepository.findById(id, this.options);
  }

  async findAllAutocomplete(search, limit) {
    return SecurityGuardRepository.findAllAutocomplete(
      search,
      limit,
      this.options,
    );
  }

  async findAndCountAll(args) {
    return SecurityGuardRepository.findAndCountAll(
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
    const count = await SecurityGuardRepository.count(
      {
        importHash,
      },
      this.options,
    );

    return count > 0;
  }
}
