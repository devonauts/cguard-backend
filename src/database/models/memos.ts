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
      // 'memo' (formal notice) or 'observacion' (lighter internal note). Both
      // are addressed to a single guard; used to talk about service quality.
      type: {
        type: DataTypes.STRING(20),
        allowNull: false,
        defaultValue: 'memo',
      },
      // Origin: the guardRating (customer review) this memo/observación was
      // generated from, when the staff acted on a specific review. Nullable —
      // memos can also be created standalone. No hard FK (mirrors guardName).
      guardRatingId: {
        type: DataTypes.UUID,
        allowNull: true,
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
