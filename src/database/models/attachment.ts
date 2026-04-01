import { DataTypes } from 'sequelize';

export default function (sequelize) {
  const attachment = sequelize.define(
    'attachment',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      name: {
        type: DataTypes.STRING(255),
        allowNull: false,
      },
      mimeType: {
        type: DataTypes.STRING(100),
        allowNull: false,
      },
      sizeInBytes: {
        type: DataTypes.INTEGER,
        allowNull: false,
      },
      storageId: {
        type: DataTypes.STRING(100),
        allowNull: false,
      },
      privateUrl: {
        type: DataTypes.STRING(1024),
        allowNull: false,
      },
      publicUrl: {
        type: DataTypes.STRING(1024),
        allowNull: true,
      },
      notableType: {
        type: DataTypes.STRING(100),
        allowNull: false,
      },
      notableId: {
        type: DataTypes.UUID,
        allowNull: false,
      },
    },
    {
      timestamps: true,
      paranoid: true,
    },
  );

  attachment.associate = (models) => {
    attachment.belongsTo(models.tenant, {
      as: 'tenant',
      foreignKey: { allowNull: false },
    });
    attachment.belongsTo(models.user, { as: 'createdBy' });
    attachment.belongsTo(models.user, { as: 'updatedBy' });
  };

  return attachment;
}
