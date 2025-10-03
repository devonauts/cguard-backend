import { DataTypes } from 'sequelize';

export default function (sequelize) {
  const report = sequelize.define(
    'report',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      title: {
        type: DataTypes.TEXT,
      },
      generatedDate: {
        type: DataTypes.DATE,
      },
      content: {
        type: DataTypes.TEXT,
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

  report.associate = (models) => {
    models.report.belongsTo(models.station, {
      as: 'station',
      constraints: false,
    });


    
    models.report.belongsTo(models.tenant, {
      as: 'tenant',
      foreignKey: {
        allowNull: false,
      },
    });

    models.report.belongsTo(models.user, {
      as: 'createdBy',
    });

    models.report.belongsTo(models.user, {
      as: 'updatedBy',
    });
  };

  return report;
}
