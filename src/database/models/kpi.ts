import { DataTypes } from 'sequelize';

export default function (sequelize) {
  const kpi = sequelize.define(
    'kpi',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      scope: {
        type: DataTypes.STRING(50),
        allowNull: false,
      },
      guardId: {
        type: DataTypes.UUID,
        allowNull: true,
      },
      postSiteId: {
        type: DataTypes.UUID,
        allowNull: true,
      },
      frequency: {
        type: DataTypes.STRING(50),
        allowNull: true,
      },
      description: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
      // Explicit report flags and counts to match frontend modal
      standardReports: {
        type: DataTypes.BOOLEAN,
        defaultValue: true,
      },
      standardReportsNumber: {
        type: DataTypes.INTEGER,
        allowNull: true,
      },
      incidentReports: {
        type: DataTypes.BOOLEAN,
        defaultValue: true,
      },
      incidentReportsNumber: {
        type: DataTypes.INTEGER,
        allowNull: true,
      },
      routeReports: {
        type: DataTypes.BOOLEAN,
        defaultValue: true,
      },
      routeReportsNumber: {
        type: DataTypes.INTEGER,
        allowNull: true,
      },
      taskReports: {
        type: DataTypes.BOOLEAN,
        defaultValue: true,
      },
      taskReportsNumber: {
        type: DataTypes.INTEGER,
        allowNull: true,
      },
      verificationReports: {
        type: DataTypes.BOOLEAN,
        defaultValue: true,
      },
      verificationReportsNumber: {
        type: DataTypes.INTEGER,
        allowNull: true,
      },
      reportOptions: {
        type: DataTypes.JSON,
        allowNull: true,
      },
      emailNotification: {
        type: DataTypes.BOOLEAN,
        defaultValue: false,
      },
      emails: {
        type: DataTypes.JSON,
        allowNull: true,
      },
      active: {
        type: DataTypes.BOOLEAN,
        defaultValue: true,
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
          fields: ['scope', 'guardId'],
        },
        {
          fields: ['scope', 'postSiteId'],
        },
      ],
      timestamps: true,
      paranoid: true,
    },
  );

  kpi.associate = (models) => {
    models.kpi.belongsTo(models.tenant, {
      as: 'tenant',
      foreignKey: {
        allowNull: false,
      },
    });

    models.kpi.belongsTo(models.user, {
      as: 'createdBy',
    });

    models.kpi.belongsTo(models.user, {
      as: 'updatedBy',
    });

    // Optional relations
    if (models.securityGuard) {
      models.kpi.belongsTo(models.securityGuard, {
        as: 'guard',
        constraints: false,
      });
    }

    if (models.businessInfo) {
      models.kpi.belongsTo(models.businessInfo, {
        as: 'postSite',
        constraints: false,
      });
    }
  };

  return kpi;
}
