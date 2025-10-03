import { DataTypes } from 'sequelize';

export default function (sequelize) {
  const inventory = sequelize.define(
    'inventory',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      belongsToStation: {
        type: DataTypes.TEXT,
      },
      radio: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      },
      radioType: {
        type: DataTypes.STRING(90),
        validate: {
          len: [0, 90],
        }
      },
      radioSerialNumber: {
        type: DataTypes.STRING(255),
        validate: {
          len: [0, 255],
        }
      },
      gun: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      },
      gunType: {
        type: DataTypes.TEXT,
        validate: {
          isIn: [[
            "revolver",
            "pistola de fuego",
            "pistola de fogeo",
            "mossberg",
            "otra arma."
          ]],
        }
      },
      gunSerialNumber: {
        type: DataTypes.STRING(255),
        validate: {
          len: [0, 255],
        }
      },
      armor: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      },
      armorType: {
        type: DataTypes.STRING(90),
        validate: {
          len: [0, 90],
        }
      },
      armorSerialNumber: {
        type: DataTypes.STRING(255),
        validate: {
          len: [0, 255],
        }
      },
      tolete: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      },
      pito: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      },
      linterna: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      },
      vitacora: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      },
      cintoCompleto: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      },
      ponchoDeAguas: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      },
      detectorDeMetales: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      },
      caseta: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      },
      observations: {
        type: DataTypes.TEXT,
        allowNull: false,
        validate: {
          len: [0, 800],
          notEmpty: true,
        }
      },
      transportation: {
        type: DataTypes.TEXT,
        allowNull: false,
        validate: {
          notEmpty: true,
          isIn: [[
            "Ninguno",
            "Bicicleta",
            "Moto",
            "Cuadrón",
            "Segway",
            "Camioneta"
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
          fields: ['radioSerialNumber', 'tenantId'],
          where: {
            deletedAt: null,
          },
        },
        {
          unique: true,
          fields: ['gunSerialNumber', 'tenantId'],
          where: {
            deletedAt: null,
          },
        },
        {
          unique: true,
          fields: ['armorSerialNumber', 'tenantId'],
          where: {
            deletedAt: null,
          },
        },
      ],
      timestamps: true,
      paranoid: true,
    },
  );

  inventory.associate = (models) => {
    models.inventory.belongsTo(models.station, {
      as: 'belongsTo',
      constraints: false,
    });


    
    models.inventory.belongsTo(models.tenant, {
      as: 'tenant',
      foreignKey: {
        allowNull: false,
      },
    });

    models.inventory.belongsTo(models.user, {
      as: 'createdBy',
    });

    models.inventory.belongsTo(models.user, {
      as: 'updatedBy',
    });
  };

  return inventory;
}
