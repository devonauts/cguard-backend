import { DataTypes } from 'sequelize';

export default function (sequelize) {
  const incident = sequelize.define(
    'incident',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      date: {
        type: DataTypes.DATE,
        allowNull: false,
      },
      title: {
        type: DataTypes.STRING(255),
        allowNull: false,
        validate: {
          len: [0, 255],
          notEmpty: true,
        }
      },
      description: {
        type: DataTypes.TEXT,
        allowNull: false,
        validate: {
          len: [0, 2500],
          notEmpty: true,
        }
      },
      callerName: {
        type: DataTypes.STRING(255),
        allowNull: true,
        validate: {
          len: [0, 255],
        },
      },
        callerType: {
          type: DataTypes.STRING(50),
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
        // Granular work status (open | inProgress | resolved | closed) so a
        // supervisor's "in progress"/"resolved" is visible in the CRM, not just
        // collapsed to the binary `status`. `status` stays the legacy source of
        // truth (abierto/cerrado); this is the finer view both apps read/write.
        workStatus: {
          type: DataTypes.STRING(20),
          allowNull: true,
          defaultValue: 'open',
        },
        dateTime: {
          type: DataTypes.DATE,
          allowNull: true,
        },
        incidentAt: {
          type: DataTypes.DATE,
          allowNull: true,
        },
        subject: {
          type: DataTypes.STRING(255),
          allowNull: true,
          validate: {
            len: [0, 255],
          },
        },
        content: {
          type: DataTypes.TEXT,
          allowNull: true,
        },
        action: {
          type: DataTypes.STRING(255),
          allowNull: true,
        },
        priority: {
          type: DataTypes.STRING(50),
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
          type: DataTypes.STRING(255),
          allowNull: true,
        },
        comments: {
          type: DataTypes.JSON,
          allowNull: true,
        },
        stationId: {
          type: DataTypes.UUID,
          allowNull: true,
        },
        clientId: {
          type: DataTypes.UUID,
          allowNull: true,
        },
        postSiteId: {
          type: DataTypes.UUID,
          allowNull: true,
        },
        guardNameId: {
          type: DataTypes.UUID,
          allowNull: true,
        },
        // Supervisor-assigned owner (distinct from the reporter guardNameId).
        assignedToUserId: {
          type: DataTypes.UUID,
          allowNull: true,
        },
        // Supervisor dispatch state: when an admin dispatches an incident to a
        // supervisor (assignedToUserId), track the supervisor's acknowledgement:
        // dispatched → accepted → enRoute → onScene. null = not dispatched.
        dispatchStatus: {
          type: DataTypes.STRING(16),
          allowNull: true,
        },
        dispatchedAt: {
          type: DataTypes.DATE,
          allowNull: true,
        },
      wasRead: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      },
      incidentTypeId: {
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
        // Incident lists (IncidentRepository.findAndCountAll default order;
        // control center sends orderBy=createdAt_DESC explicitly):
        // WHERE tenantId = ? ORDER BY createdAt DESC.
        {
          name: 'idx_inc_tenant_created',
          fields: ['tenantId', 'createdAt'],
        },
      ],
      timestamps: true,
      paranoid: true,
    },
  );

  incident.associate = (models) => {
    // Alias retained for existing includes/filters; now points at the canonical
    // stationId (the separate stationIncidentsId column was consolidated away).
    models.incident.belongsTo(models.station, {
      as: 'stationIncidents',
      foreignKey: 'stationId',
      constraints: false,
    });

    models.incident.belongsTo(models.securityGuard, {
      as: 'guardName',
      constraints: false,
      foreignKey: 'guardNameId',
    });

    models.incident.belongsTo(models.clientAccount, {
      as: 'client',
      foreignKey: 'clientId',
      constraints: false,
    });

    models.incident.belongsTo(models.station, {
      as: 'station',
      foreignKey: 'stationId',
      constraints: false,
    });

    // Alias retained; now points at the canonical postSiteId (siteId consolidated away).
    models.incident.belongsTo(models.businessInfo, {
      as: 'site',
      foreignKey: 'postSiteId',
      constraints: false,
    });

    models.incident.belongsTo(models.incidentType, {
      as: 'incidentType',
      constraints: false,
    });

    models.incident.hasMany(models.file, {
      as: 'imageUrl',
      foreignKey: 'belongsToId',
      constraints: false,
      scope: {
        belongsTo: models.incident.getTableName(),
        belongsToColumn: 'imageUrl',
      },
    });
    
    models.incident.belongsTo(models.tenant, {
      as: 'tenant',
      foreignKey: {
        allowNull: false,
      },
    });

    models.incident.belongsTo(models.user, {
      as: 'assignedTo',
      foreignKey: 'assignedToUserId',
      constraints: false,
    });

    models.incident.belongsTo(models.user, {
      as: 'createdBy',
    });

    models.incident.belongsTo(models.user, {
      as: 'updatedBy',
    });
  };

  return incident;
}
