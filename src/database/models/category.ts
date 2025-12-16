import { DataTypes } from 'sequelize';

export default function (sequelize) {
    const category = sequelize.define(
        'category',
        {
            id: {
                type: DataTypes.UUID,
                defaultValue: DataTypes.UUIDV4,
                primaryKey: true,
            },
            name: {
                type: DataTypes.STRING(255),
                allowNull: false,
                validate: {
                    notEmpty: true,
                },
            },
            description: {
                type: DataTypes.TEXT,
                allowNull: true,
            },
            module: {
                type: DataTypes.STRING(100),
                allowNull: false,
                comment: 'Module identifier (e.g., clientAccount, products, services)',
                validate: {
                    notEmpty: true,
                },
            },
            tenantId: {
                type: DataTypes.UUID,
                allowNull: false,
                references: {
                    model: 'tenants',
                    key: 'id',
                },
            },
            createdById: {
                type: DataTypes.UUID,
                references: {
                    model: 'users',
                    key: 'id',
                },
            },
            updatedById: {
                type: DataTypes.UUID,
                references: {
                    model: 'users',
                    key: 'id',
                },
            },
            importHash: {
                type: DataTypes.STRING(255),
                allowNull: true,
                unique: true,
            },
        },
        {
            indexes: [
                {
                    unique: true,
                    fields: ['importHash', 'tenantId'],
                    where: {
                        deletedAt: null,
                    },
                },
                {
                    fields: ['tenantId', 'module'],
                },
                {
                    fields: ['name', 'tenantId'],
                },
            ],
            timestamps: true,
            paranoid: true,
        },
    );

    category.associate = (models) => {
        models.category.belongsTo(models.tenant, {
            as: 'tenant',
            foreignKey: {
                allowNull: false,
            },
        });

        models.category.belongsTo(models.user, {
            as: 'createdBy',
            foreignKey: {
                name: 'createdById',
            },
        });

        models.category.belongsTo(models.user, {
            as: 'updatedBy',
            foreignKey: {
                name: 'updatedById',
            },
        });

        // Many-to-Many relationship with client accounts
        models.category.belongsToMany(models.clientAccount, {
            as: 'clientAccounts',
            through: 'clientAccountCategories',
            foreignKey: 'categoryId',
            otherKey: 'clientAccountId',
        });
    };

    return category;
}
