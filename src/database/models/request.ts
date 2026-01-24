import { DataTypes } from 'sequelize';

export default function (sequelize) {
  const request = sequelize.define(
    'request',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      dateTime: {
        type: DataTypes.DATE,
      },
      incidentAt: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      clientId: {
        type: DataTypes.UUID,
        allowNull: true,
      },
      siteId: {
        type: DataTypes.UUID,
        allowNull: true,
      },
      incidentTypeId: {
        type: DataTypes.UUID,
        allowNull: true,
      },
      priority: {
        type: DataTypes.STRING(50),
        allowNull: true,
      },
      callerType: {
        type: DataTypes.STRING(100),
        allowNull: true,
      },
      callerName: {
        type: DataTypes.STRING(255),
        allowNull: true,
      },
      internalNotes: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
      actionsTaken: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
      location: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
      status: {
        type: DataTypes.STRING(50),
        allowNull: false,
        defaultValue: 'abierto',
        validate: {
          isIn: [[
            'abierto',
            'cerrado',
          ]],
        },
      },
      subject: {
        type: DataTypes.STRING(200),
        validate: {
          len: [0, 200],
        }
      },
      content: {
        type: DataTypes.TEXT,
      },
      action: {
        type: DataTypes.TEXT,
        validate: {
          isIn: [[
            "Recibido",
            "En revisión",
            "En Proceso",
            "Aceptado",
            "Rechazado",
            "Contacte a supervisor"
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
      comments: {
        type: DataTypes.JSON,
        allowNull: true,
        defaultValue: [],
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

  request.associate = (models) => {
    models.request.belongsTo(models.securityGuard, {
      as: 'guardName',
      constraints: false,
    });

    models.request.belongsTo(models.clientAccount, {
      as: 'client',
      foreignKey: 'clientId',
      constraints: false,
    });

    models.request.belongsTo(models.businessInfo, {
      as: 'site',
      foreignKey: 'siteId',
      constraints: false,
    });

    models.request.belongsTo(models.incidentType, {
      as: 'incidentType',
      foreignKey: 'incidentTypeId',
      constraints: false,
    });

    models.request.hasMany(models.file, {
      as: 'requestDocumentPDF',
      foreignKey: 'belongsToId',
      constraints: false,
      scope: {
        belongsTo: models.request.getTableName(),
        belongsToColumn: 'requestDocumentPDF',
      },
    });
    
    models.request.belongsTo(models.tenant, {
      as: 'tenant',
      foreignKey: {
        allowNull: false,
      },
    });

    models.request.belongsTo(models.user, {
      as: 'createdBy',
    });

    models.request.belongsTo(models.user, {
      as: 'updatedBy',
    });
  };

  return request;
}
