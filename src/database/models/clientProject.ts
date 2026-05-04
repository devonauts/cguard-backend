import { DataTypes } from 'sequelize';

/**
 * ClientProject — episodic / time-bound service work for a client.
 *
 * Covers service types that don't require a permanent guard post:
 *   - event          : security for a one-time or recurring event
 *   - investigation  : background checks, site surveys, private investigations
 *   - alarm_response : on-call alarm response retainer (no fixed station)
 *   - consulting     : security consulting / risk assessment
 *   - other          : anything else
 *
 * Linked to a clientAccount (and optionally to a businessInfo/site).
 */
export default function (sequelize) {
  const clientProject = sequelize.define(
    'clientProject',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      tenantId: {
        type: DataTypes.UUID,
        allowNull: false,
      },
      clientAccountId: {
        type: DataTypes.UUID,
        allowNull: false,
      },
      // Optional link to a physical site (businessInfo)
      businessInfoId: {
        type: DataTypes.UUID,
        allowNull: true,
      },
      name: {
        type: DataTypes.STRING(200),
        allowNull: false,
        validate: { notEmpty: true, len: [1, 200] },
      },
      type: {
        type: DataTypes.STRING(50),
        allowNull: false,
        defaultValue: 'event',
        // event | investigation | alarm_response | consulting | other
      },
      description: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
      status: {
        type: DataTypes.STRING(30),
        allowNull: false,
        defaultValue: 'active',
        // active | completed | cancelled | on_hold
      },
      startDate: {
        type: DataTypes.DATEONLY,
        allowNull: true,
      },
      endDate: {
        type: DataTypes.DATEONLY,
        allowNull: true,
      },
      location: {
        type: DataTypes.STRING(300),
        allowNull: true,
      },
      estimatedHours: {
        type: DataTypes.DECIMAL(10, 2),
        allowNull: true,
      },
      assignedGuards: {
        type: DataTypes.JSON,
        allowNull: true,
        defaultValue: [],
      },
      notes: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
    },
    {
      tableName: 'clientProjects',
    },
  );

  (clientProject as any).associate = (models: any) => {
    clientProject.belongsTo(models.clientAccount, {
      as: 'clientAccount',
      foreignKey: 'clientAccountId',
    });
    clientProject.belongsTo(models.businessInfo, {
      as: 'site',
      foreignKey: 'businessInfoId',
    });
  };

  return clientProject;
}
