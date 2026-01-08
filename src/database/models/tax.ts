import { DataTypes } from 'sequelize';

export default function (sequelize) {
    const tax = sequelize.define(
        'tax',
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
            rate: {
                type: DataTypes.DECIMAL(10, 2),
                allowNull: false,
                defaultValue: 0,
            },
            description: {
                type: DataTypes.TEXT,
                allowNull: true,
            },
            active: {
                type: DataTypes.BOOLEAN,
                allowNull: false,
                defaultValue: true,
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
        },
        {
            indexes: [
                {
                    fields: ['tenantId'],
                },
                {
                    fields: ['name', 'tenantId'],
                },
            ],
            timestamps: true,
            paranoid: true,
        },
    );

    tax.associate = (models) => {
        models.tax.belongsTo(models.tenant, {
            as: 'tenant',
            foreignKey: {
                allowNull: false,
            },
        });

        models.tax.belongsTo(models.user, {
            as: 'createdBy',
            foreignKey: {
                name: 'createdById',
            },
        });

        models.tax.belongsTo(models.user, {
            as: 'updatedBy',
            foreignKey: {
                name: 'updatedById',
            },
        });
    };

    return tax;
}
