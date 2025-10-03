import { DataTypes } from 'sequelize';

export default function (sequelize) {
  const additionalService = sequelize.define(
    'additionalService',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      stationAditionalServiceName: {
        type: DataTypes.STRING(250),
        allowNull: false,
        validate: {
          len: [0, 250],
          notEmpty: true,
        }
      },
      dvr: {
        type: DataTypes.TEXT,
        validate: {
          isIn: [[
            "Dvr con disco duro 500 GB",
            "Dvr con disco duro de 1 TB",
            "Dvr con disco duro de 2 TB"
          ]],
        }
      },
      dvrSerialCode: {
        type: DataTypes.STRING(100),
        allowNull: false,
        validate: {
          len: [0, 100],
          notEmpty: true,
        }
      },
      juegoDeCamarasInteriores: {
        type: DataTypes.TEXT,
        validate: {
          isIn: [[
            "0",
            "2",
            "4",
            "6",
            "8",
            "10",
            "12",
            "14",
            "16"
          ]],
        }
      },
      juegoDeCamarasExteriores: {
        type: DataTypes.TEXT,
        validate: {
          isIn: [[
            "0",
            "2",
            "4",
            "6",
            "8",
            "10",
            "12",
            "14",
            "16"
          ]],
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
        {
          unique: true,
          fields: ['dvrSerialCode', 'tenantId'],
          where: {
            deletedAt: null,
          },
        },
      ],
      timestamps: true,
      paranoid: true,
    },
  );

  additionalService.associate = (models) => {
    models.additionalService.belongsTo(models.station, {
      as: 'stations',
      constraints: false,
    });


    
    models.additionalService.belongsTo(models.tenant, {
      as: 'tenant',
      foreignKey: {
        allowNull: false,
      },
    });

    models.additionalService.belongsTo(models.user, {
      as: 'createdBy',
    });

    models.additionalService.belongsTo(models.user, {
      as: 'updatedBy',
    });
  };

  return additionalService;
}
