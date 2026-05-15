import { DataTypes } from 'sequelize';

export default function (sequelize) {
  const inventoryItem = sequelize.define(
    'inventoryItem',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      name: {
        type: DataTypes.STRING(255),
        allowNull: false,
        validate: { len: [1, 255], notEmpty: true },
      },
      type: {
        type: DataTypes.ENUM(
          'radio',
          'arma',
          'chaleco_antibalas',
          'tolete',
          'pito',
          'linterna',
          'bitacora',
          'cinto_completo',
          'poncho_de_aguas',
          'detector_de_metales',
          'caseta',
          'vehiculo',
          'otro',
        ),
        allowNull: false,
        defaultValue: 'otro',
      },
      brand: {
        type: DataTypes.STRING(100),
        allowNull: true,
        validate: { len: [0, 100] },
      },
      modelName: {
        type: DataTypes.STRING(100),
        allowNull: true,
        validate: { len: [0, 100] },
      },
      serialNumber: {
        type: DataTypes.STRING(255),
        allowNull: true,
        validate: { len: [0, 255] },
      },
      condition: {
        type: DataTypes.ENUM('bueno', 'regular', 'dañado'),
        allowNull: false,
        defaultValue: 'bueno',
      },
      status: {
        type: DataTypes.ENUM('disponible', 'asignado', 'en_mantenimiento', 'retirado'),
        allowNull: false,
        defaultValue: 'disponible',
      },
      notes: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
      expirationDate: {
        type: DataTypes.DATEONLY,
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
        {
          unique: true,
          fields: ['serialNumber', 'tenantId'],
          where: { deletedAt: null, serialNumber: { [require('sequelize').Op.ne]: null } },
        },
      ],
      timestamps: true,
      paranoid: true,
    },
  );

  inventoryItem.associate = (models) => {
    models.inventoryItem.belongsTo(models.tenant, {
      as: 'tenant',
      foreignKey: { allowNull: false },
    });
    models.inventoryItem.belongsTo(models.user, { as: 'createdBy' });
    models.inventoryItem.belongsTo(models.user, { as: 'updatedBy' });
    models.inventoryItem.hasMany(models.inventoryAssignment, {
      as: 'assignments',
      foreignKey: 'inventoryItemId',
    });
  };

  return inventoryItem;
}
