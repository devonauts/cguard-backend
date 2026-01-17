import { DataTypes } from 'sequelize';

export default function (sequelize) {
  const tenantCounter = sequelize.define(
    'tenantCounter',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      key: {
        type: DataTypes.STRING(100),
        allowNull: false,
      },
      value: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
      },
      importHash: {
        type: DataTypes.STRING(255),
        allowNull: true,
      },
    },
    {
      indexes: [
        {
          unique: true,
          fields: ['tenantId', 'key'],
        },
      ],
      timestamps: true,
      paranoid: true,
    },
  );

  tenantCounter.associate = (models) => {
    tenantCounter.belongsTo(models.tenant, {
      as: 'tenant',
      foreignKey: {
        allowNull: false,
      },
    });
  };

  return tenantCounter;
}
