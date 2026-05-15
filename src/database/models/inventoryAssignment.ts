import { DataTypes } from 'sequelize';

export default function (sequelize) {
  const inventoryAssignment = sequelize.define(
    'inventoryAssignment',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      inventoryItemId: {
        type: DataTypes.UUID,
        allowNull: false,
      },
      stationId: {
        type: DataTypes.UUID,
        allowNull: true,
      },
      postSiteId: {
        type: DataTypes.UUID,
        allowNull: true,
      },
      assignedToUserId: {
        type: DataTypes.UUID,
        allowNull: true,
      },
      assignedAt: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
      },
      returnedAt: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      conditionAtCheckout: {
        type: DataTypes.ENUM('bueno', 'regular', 'dañado'),
        allowNull: true,
      },
      conditionAtReturn: {
        type: DataTypes.ENUM('bueno', 'regular', 'dañado'),
        allowNull: true,
      },
      notes: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
      returnNotes: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
      importHash: {
        type: DataTypes.STRING(255),
        allowNull: true,
        validate: { len: [0, 255] },
      },
    },
    {
      indexes: [
        {
          unique: true,
          fields: ['importHash', 'tenantId'],
          where: { deletedAt: null },
        },
      ],
      timestamps: true,
      paranoid: true,
    },
  );

  inventoryAssignment.associate = (models) => {
    models.inventoryAssignment.belongsTo(models.inventoryItem, {
      as: 'inventoryItem',
      foreignKey: 'inventoryItemId',
    });
    models.inventoryAssignment.belongsTo(models.station, {
      as: 'station',
      foreignKey: 'stationId',
      constraints: false,
    });
    models.inventoryAssignment.belongsTo(models.businessInfo, {
      as: 'postSite',
      foreignKey: 'postSiteId',
      constraints: false,
    });
    models.inventoryAssignment.belongsTo(models.user, {
      as: 'assignedTo',
      foreignKey: 'assignedToUserId',
      constraints: false,
    });
    models.inventoryAssignment.belongsTo(models.tenant, {
      as: 'tenant',
      foreignKey: { allowNull: false },
    });
    models.inventoryAssignment.belongsTo(models.user, { as: 'createdBy' });
    models.inventoryAssignment.belongsTo(models.user, { as: 'updatedBy' });
  };

  return inventoryAssignment;
}
