import { DataTypes } from 'sequelize';

export default function (sequelize) {
  const clientContact = sequelize.define(
    'clientContact',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      name: {
        type: DataTypes.STRING(200),
        allowNull: false,
        validate: { len: [0, 200], notEmpty: true },
      },

      email: {
        type: DataTypes.STRING(150),
        allowNull: true,
        validate: { len: [0, 150] },
      },
      mobile: {
        type: DataTypes.STRING(30),
        allowNull: true,
        validate: { len: [0, 30] },
      },
      description: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
      postSiteId: {
        type: DataTypes.UUID,
        allowNull: true,
      },
      allowGuard: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      },
      importHash: {
        type: DataTypes.STRING(255),
        allowNull: true,
        validate: { len: [0, 255] },
      },
    },
    {
      timestamps: true,
      paranoid: true,
    },
  );

  clientContact.associate = (models) => {
    models.clientContact.belongsTo(models.tenant, {
      as: 'tenant',
      foreignKey: {
        allowNull: false,
      },
    });

    models.clientContact.belongsTo(models.user, {
      as: 'createdBy',
    });

    models.clientContact.belongsTo(models.user, {
      as: 'updatedBy',
    });

    models.clientContact.belongsTo(models.clientAccount, {
      as: 'clientAccount',
      foreignKey: 'clientAccountId',
    });

    // Optional relation to postSite (businessInfo)
    models.clientContact.belongsTo(models.businessInfo, {
      as: 'postSite',
      foreignKey: 'postSiteId',
    });
  };

  return clientContact;
}
