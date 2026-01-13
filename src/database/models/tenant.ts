import Plans from '../../security/plans';

const plans = Plans.values;

export default function (sequelize, DataTypes) {
  const tenant = sequelize.define(
    'tenant',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      name: {
        type: DataTypes.STRING(255),
        allowNull: false,
        validation: {
          notEmpty: true,
          len: [0, 255],
        },
      },
      url: {
        type: DataTypes.STRING(50),
        allowNull: false,
        validation: {
          notEmpty: true,
          len: [0, 50],
        },
      },
      plan: {
        type: DataTypes.STRING(255),
        allowNull: false,
        validate: {
          notEmpty: true,
          isIn: [
            [plans.free, plans.growth, plans.enterprise],
          ],
        },
        defaultValue: plans.free,
      },
      planStatus: {
        type: DataTypes.STRING(255),
        allowNull: false,
        validate: {
          notEmpty: true,
          isIn: [
            ['active', 'cancel_at_period_end', 'error'],
          ],
        },
        defaultValue: 'active'
      },
      planStripeCustomerId: {
        type: DataTypes.STRING(255),
        validate: {
          len: [0, 255],
        }
      },
      planUserId: {
        type: DataTypes.UUID,
      },
      // Contact / Business fields added to support invoices/presupuestos
      address: {
        type: DataTypes.TEXT,
        allowNull: false,
        validate: {
          notEmpty: true,
        },
      },
      phone: {
        type: DataTypes.STRING(50),
        allowNull: false,
        validate: {
          notEmpty: true,
        },
      },
      email: {
        type: DataTypes.STRING(255),
        allowNull: false,
        validate: {
          notEmpty: true,
          isEmail: true,
        },
      },
      logoId: {
        type: DataTypes.UUID,
        allowNull: true,
        references: {
          model: 'files',
          key: 'id',
        },
      },
      taxNumber: {
        type: DataTypes.STRING(255),
        allowNull: false,
        validate: {
          notEmpty: true,
        },
      },
      businessTitle: {
        type: DataTypes.STRING(255),
        allowNull: false,
        validate: {
          notEmpty: true,
        },
      },
      extraLines: {
        type: DataTypes.TEXT,
        allowNull: false,
        defaultValue: '',
      },
      website: {
        type: DataTypes.STRING(255),
        allowNull: false,
        validate: {
          len: [0, 255],
        },
        defaultValue: '',
      },
      licenseNumber: {
        type: DataTypes.STRING(255),
        allowNull: false,
        validate: {
          len: [0, 255],
        },
        defaultValue: '',
      },
      timezone: {
        type: DataTypes.STRING(100),
        allowNull: false,
        validate: {
          notEmpty: true,
        },
        defaultValue: 'UTC',
      },
    },
    {
      indexes: [
        {
          unique: true,
          fields: ['url'],
          where: {
            deletedAt: null,
          },
        },
      ],
      timestamps: true,
      paranoid: true,
    },
  );

  tenant.associate = (models) => {
    models.tenant.hasMany(models.settings, {
      as: 'settings',
    });

    models.tenant.hasMany(models.tenantUser, {
      as: 'users',
    });

    models.tenant.belongsTo(models.file, {
      as: 'logo',
      foreignKey: 'logoId',
    });

    models.tenant.belongsTo(models.user, {
      as: 'createdBy',
    });

    models.tenant.belongsTo(models.user, {
      as: 'updatedBy',
    });
  };

  return tenant;
}
