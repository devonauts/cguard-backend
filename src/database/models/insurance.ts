import { DataTypes } from 'sequelize';import moment from 'moment';

export default function (sequelize) {
  const insurance = sequelize.define(
    'insurance',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      provider: {
        type: DataTypes.TEXT,
      },
      policyNumber: {
        type: DataTypes.TEXT,
      },
      validFrom: {
        type: DataTypes.DATEONLY,
        get: function() {
          // @ts-ignore
          return this.getDataValue('validFrom')
            ? moment
                // @ts-ignore
                .utc(this.getDataValue('validFrom'))
                .format('YYYY-MM-DD')
            : null;
        },
      },
      validUntil: {
        type: DataTypes.DATEONLY,
        get: function() {
          // @ts-ignore
          return this.getDataValue('validUntil')
            ? moment
                // @ts-ignore
                .utc(this.getDataValue('validUntil'))
                .format('YYYY-MM-DD')
            : null;
        },
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

      ],
      timestamps: true,
      paranoid: true,
    },
  );

  insurance.associate = (models) => {


    models.insurance.hasMany(models.file, {
      as: 'document',
      foreignKey: 'belongsToId',
      constraints: false,
      scope: {
        belongsTo: models.insurance.getTableName(),
        belongsToColumn: 'document',
      },
    });
    
    models.insurance.belongsTo(models.tenant, {
      as: 'tenant',
      foreignKey: {
        allowNull: false,
      },
    });

    models.insurance.belongsTo(models.user, {
      as: 'createdBy',
    });

    models.insurance.belongsTo(models.user, {
      as: 'updatedBy',
    });
  };

  return insurance;
}
