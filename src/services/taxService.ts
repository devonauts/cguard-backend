import Error400 from '../errors/Error400';
import SequelizeRepository from '../database/repositories/sequelizeRepository';
import { IServiceOptions } from './IServiceOptions';
import TaxRepository from '../database/repositories/taxRepository';

export default class TaxService {
    options: IServiceOptions;

    constructor(options) {
        this.options = options;
    }

    async create(data) {
        const transaction = await SequelizeRepository.createTransaction(
            this.options.database,
        );

        try {
            const record = await TaxRepository.create(data, {
                ...this.options,
                transaction,
            });

            await SequelizeRepository.commitTransaction(transaction);

            return record;
        } catch (error) {
            await SequelizeRepository.rollbackTransaction(transaction);
            throw error;
        }
    }

    async update(id, data) {
        const transaction = await SequelizeRepository.createTransaction(
            this.options.database,
        );

        try {
            const record = await TaxRepository.update(id, data, {
                ...this.options,
                transaction,
            });

            await SequelizeRepository.commitTransaction(transaction);

            return record;
        } catch (error) {
            await SequelizeRepository.rollbackTransaction(transaction);
            throw error;
        }
    }

    async destroyAll(ids) {
        const transaction = await SequelizeRepository.createTransaction(
            this.options.database,
        );

        try {
            for (const id of ids) {
                await TaxRepository.destroy(id, {
                    ...this.options,
                    transaction,
                });
            }

            await SequelizeRepository.commitTransaction(transaction);
        } catch (error) {
            await SequelizeRepository.rollbackTransaction(transaction);
            throw error;
        }
    }

    async findById(id) {
        return TaxRepository.findById(id, this.options);
    }

    async findAllAutocomplete(search, limit) {
        return TaxRepository.findAllAutocomplete(search, limit, this.options);
    }

    async findAndCountAll(args) {
        return TaxRepository.findAndCountAll(args, this.options);
    }
}
