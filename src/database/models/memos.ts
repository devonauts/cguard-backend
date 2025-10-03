import { DataTypes } from 'sequelize';

export default function (sequelize) {
  const memos = sequelize.define(
    'memos',
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
        validate: {
          len: [0, 800],
        }
      },
      wasAccepted: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
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

  memos.associate = (models) => {
    models.memos.belongsTo(models.securityGuard, {
      as: 'guardName',
      constraints: false,
    });

    models.memos.hasMany(models.file, {
      as: 'memoDocumentPdf',
      foreignKey: 'belongsToId',
      constraints: false,
      scope: {
        belongsTo: models.memos.getTableName(),
        belongsToColumn: 'memoDocumentPdf',
      },
    });
    
    models.memos.belongsTo(models.tenant, {
      as: 'tenant',
      foreignKey: {
        allowNull: false,
      },
    });

    models.memos.belongsTo(models.user, {
      as: 'createdBy',
    });

    models.memos.belongsTo(models.user, {
      as: 'updatedBy',
    });
  };

  return memos;
}
