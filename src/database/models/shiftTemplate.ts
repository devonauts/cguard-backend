import { DataTypes } from 'sequelize';

/**
 * Reusable shift template (Programador · Plantillas de turno). Stores a named
 * start/end window plus optional defaults (post site, guard, skill, etc.) used
 * to speed up building the schedule. Replaces the former localStorage-only stub.
 */
export default function (sequelize) {
  const shiftTemplate = sequelize.define(
    'shiftTemplate',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      templateName: {
        type: DataTypes.STRING(255),
        allowNull: false,
      },
      startTime: {
        type: DataTypes.STRING(10),
        allowNull: false,
      },
      endTime: {
        type: DataTypes.STRING(10),
        allowNull: false,
      },
      repeatShift: {
        type: DataTypes.STRING(50),
        allowNull: true,
      },
      repeatBy: {
        type: DataTypes.STRING(50),
        allowNull: true,
      },
      postSiteId: {
        type: DataTypes.UUID,
        allowNull: true,
      },
      guardId: {
        type: DataTypes.UUID,
        allowNull: true,
      },
      skillSet: {
        type: DataTypes.STRING(100),
        allowNull: true,
      },
      department: {
        type: DataTypes.STRING(100),
        allowNull: true,
      },
      breakDuration: {
        type: DataTypes.STRING(50),
        allowNull: true,
      },
      note: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
      category: {
        type: DataTypes.STRING(50),
        allowNull: true,
      },
      status: {
        type: DataTypes.STRING(50),
        allowNull: false,
        defaultValue: 'active',
      },
      importHash: {
        type: DataTypes.STRING(255),
        allowNull: true,
      },
    },
    {
      timestamps: true,
      paranoid: true,
    },
  );

  shiftTemplate.associate = (models) => {
    models.shiftTemplate.belongsTo(models.tenant, {
      as: 'tenant',
      foreignKey: { allowNull: false },
    });

    models.shiftTemplate.belongsTo(models.user, {
      as: 'createdBy',
    });

    models.shiftTemplate.belongsTo(models.user, {
      as: 'updatedBy',
    });
  };

  return shiftTemplate;
}
