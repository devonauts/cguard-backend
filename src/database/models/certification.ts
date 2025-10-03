import { DataTypes } from 'sequelize';import moment from 'moment';

export default function (sequelize) {
  const certification = sequelize.define(
    'certification',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      title: {
        type: DataTypes.STRING(255),
        allowNull: false,
        validate: {
          len: [0, 255],
          notEmpty: true,
        }
      },
      code: {
        type: DataTypes.STRING(255),
        allowNull: false,
        validate: {
          len: [0, 255],
          notEmpty: true,
        }
      },
      description: {
        type: DataTypes.TEXT,
        allowNull: false,
        validate: {
          len: [0, 800],
          notEmpty: true,
        }
      },
      acquisitionDate: {
        type: DataTypes.DATEONLY,
        get: function() {
          // @ts-ignore
          return this.getDataValue('acquisitionDate')
            ? moment
                // @ts-ignore
                .utc(this.getDataValue('acquisitionDate'))
                .format('YYYY-MM-DD')
            : null;
        },
        allowNull: false,
      },
      expirationDate: {
        type: DataTypes.DATEONLY,
        get: function() {
          // @ts-ignore
          return this.getDataValue('expirationDate')
            ? moment
                // @ts-ignore
                .utc(this.getDataValue('expirationDate'))
                .format('YYYY-MM-DD')
            : null;
        },
        allowNull: false,
      },
      importHash: {
        type: DataTypes.STRING(255),
        allowNull: true,    
        validate: {
          len: [0, 255],
        },    
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
          unique: true,
          fields: ['code', 'tenantId'],
          where: {
            deletedAt: null,
          },
        },
      ],
      timestamps: true,
      paranoid: true,
    },
  );

  certification.associate = (models) => {


    models.certification.hasMany(models.file, {
      as: 'image',
      foreignKey: 'belongsToId',
      constraints: false,
      scope: {
        belongsTo: models.certification.getTableName(),
        belongsToColumn: 'image',
      },
    });

    models.certification.hasMany(models.file, {
      as: 'icon',
      foreignKey: 'belongsToId',
      constraints: false,
      scope: {
        belongsTo: models.certification.getTableName(),
        belongsToColumn: 'icon',
      },
    });
    
    models.certification.belongsTo(models.tenant, {
      as: 'tenant',
      foreignKey: {
        allowNull: false,
      },
    });

    models.certification.belongsTo(models.user, {
      as: 'createdBy',
    });

    models.certification.belongsTo(models.user, {
      as: 'updatedBy',
    });
  };

  return certification;
}
