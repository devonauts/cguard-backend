import { DataTypes } from 'sequelize';

export default function (sequelize) {
  const deviceIdInformation = sequelize.define(
    'deviceIdInformation',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      deviceId: {
        type: DataTypes.STRING(200),
        validate: {
          len: [0, 200],
        }
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

  deviceIdInformation.associate = (models) => {



    
    models.deviceIdInformation.belongsTo(models.tenant, {
      as: 'tenant',
      foreignKey: {
        allowNull: false,
      },
    });

    models.deviceIdInformation.belongsTo(models.user, {
      as: 'createdBy',
    });

    models.deviceIdInformation.belongsTo(models.user, {
      as: 'updatedBy',
    });
  };

  return deviceIdInformation;
}
