import { DataTypes } from 'sequelize';

/**
 * Junction table for Many-to-Many relationship between ClientAccounts and Categories
 */
export default function (sequelize) {
  const clientAccountCategory = sequelize.define(
    'clientAccountCategory',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      clientAccountId: {
        type: DataTypes.UUID,
        allowNull: false,
        references: {
          model: 'clientAccounts',
          key: 'id',
        },
      },
      categoryId: {
        type: DataTypes.UUID,
        allowNull: false,
        references: {
          model: 'categories',
          key: 'id',
        },
      },
    },
    {
      indexes: [
        {
          unique: true,
          fields: ['clientAccountId', 'categoryId'],
        },
        {
          fields: ['clientAccountId'],
        },
        {
          fields: ['categoryId'],
        },
      ],
      timestamps: true,
      paranoid: true,
    },
  );

  return clientAccountCategory;
}
