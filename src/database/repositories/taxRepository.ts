import SequelizeRepository from './sequelizeRepository';
import AuditLogRepository from './auditLogRepository';
import lodash from 'lodash';
import SequelizeFilterUtils from '../utils/sequelizeFilterUtils';
import Error404 from '../../errors/Error404';
import Error400 from '../../errors/Error400';
import Sequelize from 'sequelize';
import { IRepositoryOptions } from './IRepositoryOptions';

const Op = Sequelize.Op;

class TaxRepository {
    static async create(data, options: IRepositoryOptions) {
        const currentUser = SequelizeRepository.getCurrentUser(options);
        const tenant = SequelizeRepository.getCurrentTenant(options);
        const transaction = SequelizeRepository.getTransaction(options);

        // Validate uniqueness of name within the tenant
        try {
            if (data.name) {
                const existing = await options.database.tax.findOne({
                    where: {
                        tenantId: tenant.id,
                        name: data.name,
                    },
                    transaction,
                });

                if (existing) {
                    throw new Error400(options.language, 'entities.tax.errors.exists');
                }
            }
        } catch (err) {
            if (err instanceof Error400) throw err;
        }

        const record = await options.database.tax.create(
            {
                ...lodash.pick(data, [
                    'name',
                    'rate',
                    'description',
                    'active',
                ]),
                tenantId: tenant.id,
                createdById: currentUser.id,
                updatedById: currentUser.id,
            },
            {
                transaction,
            },
        );

        await this._createAuditLog(
            AuditLogRepository.CREATE,
            record,
            data,
            options,
        );

        return this.findById(record.id, options);
    }

    static async update(id, data, options: IRepositoryOptions) {
        const currentUser = SequelizeRepository.getCurrentUser(options);
        const transaction = SequelizeRepository.getTransaction(options);

        const currentTenant = SequelizeRepository.getCurrentTenant(options);

        let record = await options.database.tax.findOne({
            where: {
                id,
                tenantId: currentTenant.id,
            },
            transaction,
        });

        if (!record) {
            throw new Error404();
        }

        // Validate uniqueness of name within the tenant (exclude current record)
        try {
            if (data.name) {
                const existing = await options.database.tax.findOne({
                    where: {
                        tenantId: currentTenant.id,
                        name: data.name,
                        id: { [Op.ne]: id },
                    },
                    transaction,
                });

                if (existing) {
                    console.warn('Tax update validation: duplicate name detected', { existingId: existing.id, name: existing.name });
                    throw new Error400(options.language, 'entities.tax.errors.exists');
                }
            }
        } catch (err) {
            if (err instanceof Error400) throw err;
        }

        record = await record.update(
            {
                ...lodash.pick(data, [
                    'name',
                    'rate',
                    'description',
                    'active',
                ]),
                updatedById: currentUser.id,
            },
            {
                transaction,
            },
        );

        await this._createAuditLog(
            AuditLogRepository.UPDATE,
            record,
            data,
            options,
        );

        return this.findById(record.id, options);
    }

    static async destroy(id, options: IRepositoryOptions) {
        const transaction = SequelizeRepository.getTransaction(options);

        const currentTenant = SequelizeRepository.getCurrentTenant(options);

        let record = await options.database.tax.findOne({
            where: {
                id,
                tenantId: currentTenant.id,
            },
            transaction,
        });

        if (!record) {
            throw new Error404();
        }

        await record.destroy({
            transaction,
        });

        await this._createAuditLog(
            AuditLogRepository.DELETE,
            record,
            record,
            options,
        );
    }

    static async findById(id, options: IRepositoryOptions) {
        const transaction = SequelizeRepository.getTransaction(options);

        const include = [];

        const currentTenant = SequelizeRepository.getCurrentTenant(options);

        const record = await options.database.tax.findOne({
            where: {
                id,
                tenantId: currentTenant.id,
            },
            include,
            transaction,
        });

        if (!record) {
            throw new Error404();
        }

        return this._fillWithRelationsAndFiles(record, options);
    }

    static async filterIdInTenant(id, options: IRepositoryOptions) {
        return lodash.get(
            await this.filterIdsInTenant([id], options),
            '[0]',
            null,
        );
    }

    static async filterIdsInTenant(ids, options: IRepositoryOptions) {
        if (!ids || !ids.length) {
            return [];
        }

        const currentTenant = SequelizeRepository.getCurrentTenant(options);

        const where = {
            id: {
                [Op.in]: ids,
            },
            tenantId: currentTenant.id,
        };

        const records = await options.database.tax.findAll({
            attributes: ['id'],
            where,
        });

        return records.map((record) => record.id);
    }

    static async count(filter, options: IRepositoryOptions) {
        const transaction = SequelizeRepository.getTransaction(options);

        const tenant = SequelizeRepository.getCurrentTenant(options);

        return options.database.tax.count({
            where: {
                ...filter,
                tenantId: tenant.id,
            },
            transaction,
        });
    }

    static async findAndCountAll(
        { filter, limit = 0, offset = 0, orderBy = '' },
        options: IRepositoryOptions,
    ) {
        const tenant = SequelizeRepository.getCurrentTenant(options);

        let whereAnd: Array<any> = [];
        let include = [];

        whereAnd.push({
            tenantId: tenant.id,
        });

        if (filter) {
            if (filter.id) {
                whereAnd.push({
                    ['id']: SequelizeFilterUtils.uuid(filter.id),
                });
            }

            if (filter.name) {
                whereAnd.push(
                    SequelizeFilterUtils.ilikeIncludes(
                        'tax',
                        'name',
                        filter.name,
                    ),
                );
            }

            if (filter.createdAtRange) {
                const [start, end] = filter.createdAtRange;

                if (start !== undefined && start !== null && start !== '') {
                    whereAnd.push({
                        ['createdAt']: {
                            [Op.gte]: start,
                        },
                    });
                }

                if (end !== undefined && end !== null && end !== '') {
                    whereAnd.push({
                        ['createdAt']: {
                            [Op.lte]: end,
                        },
                    });
                }
            }
        }

        const where = { [Op.and]: whereAnd };
        let { rows, count } = await options.database.tax.findAndCountAll({
            where,
            include,
            limit: limit ? Number(limit) : undefined,
            offset: offset ? Number(offset) : undefined,
            order: orderBy
                ? [orderBy.split('_')]
                : [['name', 'ASC']],
            transaction: SequelizeRepository.getTransaction(options),
        });

        rows = await this._fillWithRelationsAndFilesForRows(rows, options);

        return { rows, count };
    }

    static async findAllAutocomplete(search, limit, options: IRepositoryOptions) {
        const tenant = SequelizeRepository.getCurrentTenant(options);

        let whereAnd: Array<any> = [
            {
                tenantId: tenant.id,
            },
        ];

        if (search) {
            whereAnd.push({
                [Op.or]: [
                    { ['id']: SequelizeFilterUtils.uuid(search) },
                    {
                        [Op.and]: SequelizeFilterUtils.ilikeIncludes(
                            'tax',
                            'name',
                            search,
                        ),
                    },
                ],
            });
        }

        const where = { [Op.and]: whereAnd };

        const records = await options.database.tax.findAll({
            attributes: ['id', 'name'],
            where,
            limit: limit ? Number(limit) : undefined,
            order: [['name', 'ASC']],
        });

        return records.map((record) => ({
            id: record.id,
            label: record.name,
        }));
    }

    static async _createAuditLog(action, record, data, options: IRepositoryOptions) {
        let values = {};

        if (data) {
            values = {
                ...record.get({ plain: true }),
            };
        }

        await AuditLogRepository.log(
            {
                entityName: 'tax',
                entityId: record.id,
                action,
                values,
            },
            options,
        );
    }

    static async _fillWithRelationsAndFilesForRows(rows, options: IRepositoryOptions) {
        if (!rows) {
            return rows;
        }

        return Promise.all(
            rows.map((record) =>
                this._fillWithRelationsAndFiles(record, options),
            ),
        );
    }

    static async _fillWithRelationsAndFiles(record, options: IRepositoryOptions) {
        if (!record) {
            return record;
        }

        const output = record.get({ plain: true });

        return output;
    }
}

export default TaxRepository;
