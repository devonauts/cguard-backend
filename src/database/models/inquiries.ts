import { DataTypes } from 'sequelize';

export default function (sequelize) {
  const inquiries = sequelize.define(
    'inquiries',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      names: {
        type: DataTypes.STRING(200),
        allowNull: false,
        validate: {
          len: [0, 200],
          notEmpty: true,
        }
      },
      city: {
        type: DataTypes.STRING(70),
        allowNull: false,
        validate: {
          len: [0, 70],
          notEmpty: true,
        }
      },
      email: {
        type: DataTypes.STRING(200),
        allowNull: false,
        validate: {
          len: [0, 200],
          notEmpty: true,
        }
      },
      phoneNumber: {
        type: DataTypes.STRING(10),
        allowNull: false,
        validate: {
          len: [0, 10],
          notEmpty: true,
        }
      },
      message: {
        type: DataTypes.TEXT,
        allowNull: false,
        validate: {
          len: [0, 300],
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

  inquiries.associate = (models) => {
    models.inquiries.belongsTo(models.service, {
      as: 'serviceOfInterest',
      constraints: false,
      foreignKey: {
        allowNull: false,
      },
    });


    
    models.inquiries.belongsTo(models.tenant, {
      as: 'tenant',
      foreignKey: {
        allowNull: false,
      },
    });

    models.inquiries.belongsTo(models.user, {
      as: 'createdBy',
    });

    models.inquiries.belongsTo(models.user, {
      as: 'updatedBy',
    });
  };

  return inquiries;
}
