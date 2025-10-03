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
