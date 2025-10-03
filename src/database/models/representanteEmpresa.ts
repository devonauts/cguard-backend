import { DataTypes } from 'sequelize';

export default function (sequelize) {
  const representanteEmpresa = sequelize.define(
    'representanteEmpresa',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      governmentId: {
        type: DataTypes.STRING(10),
        allowNull: false,
        validate: {
          len: [0, 10],
          notEmpty: true,
        }
      },
      jobTitle: {
        type: DataTypes.STRING(90),
        allowNull: false,
        validate: {
          len: [0, 90],
          notEmpty: true,
        }
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

      ],
      timestamps: true,
      paranoid: true,
    },
  );

  representanteEmpresa.associate = (models) => {
    models.representanteEmpresa.belongsTo(models.user, {
      as: 'personInCharge',
      constraints: false,
    });

    models.representanteEmpresa.belongsTo(models.clientAccount, {
      as: 'assignedCompany',
      constraints: false,
      foreignKey: {
        allowNull: false,
      },
    });


    
    models.representanteEmpresa.belongsTo(models.tenant, {
      as: 'tenant',
      foreignKey: {
        allowNull: false,
      },
    });

    models.representanteEmpresa.belongsTo(models.user, {
      as: 'createdBy',
    });

    models.representanteEmpresa.belongsTo(models.user, {
      as: 'updatedBy',
    });
  };

  return representanteEmpresa;
}
