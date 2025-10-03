import { DataTypes } from 'sequelize';import moment from 'moment';

export default function (sequelize) {
  const securityGuard = sequelize.define(
    'securityGuard',
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
      fullName: {
        type: DataTypes.STRING(200),
        allowNull: false,
        validate: {
          len: [0, 200],
          notEmpty: true,
        }
      },
      hiringContractDate: {
        type: DataTypes.DATEONLY,
        get: function() {
          // @ts-ignore
          return this.getDataValue('hiringContractDate')
            ? moment
                // @ts-ignore
                .utc(this.getDataValue('hiringContractDate'))
                .format('YYYY-MM-DD')
            : null;
        },
      },
      gender: {
        type: DataTypes.TEXT,
        allowNull: false,
        validate: {
          notEmpty: true,
          isIn: [[
            "Masculino",
            "Femenino"
          ]],
        }
      },
      isOnDuty: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      },
      bloodType: {
        type: DataTypes.TEXT,
        allowNull: false,
        validate: {
          notEmpty: true,
          isIn: [[
            "A+",
            "A-",
            "AB+",
            "AB-",
            "O+",
            "O-",
            "B+",
            "B-"
          ]],
        }
      },
      guardCredentials: {
        type: DataTypes.STRING(255),
        validate: {
          len: [0, 255],
        }
      },
      birthDate: {
        type: DataTypes.DATEONLY,
        get: function() {
          // @ts-ignore
          return this.getDataValue('birthDate')
            ? moment
                // @ts-ignore
                .utc(this.getDataValue('birthDate'))
                .format('YYYY-MM-DD')
            : null;
        },
        allowNull: false,
      },
      birthPlace: {
        type: DataTypes.STRING(50),
        validate: {
          len: [0, 50],
        }
      },
      maritalStatus: {
        type: DataTypes.TEXT,
        allowNull: false,
        validate: {
          notEmpty: true,
          isIn: [[
            "Soltero",
            "Casado",
            "Unión libre",
            "Divorciado"
          ]],
        }
      },
      academicInstruction: {
        type: DataTypes.TEXT,
        allowNull: false,
        validate: {
          notEmpty: true,
          isIn: [[
            "Secundaria",
            "Universitaria",
            "Especial"
          ]],
        }
      },
      address: {
        type: DataTypes.STRING(200),
        validate: {
          len: [0, 200],
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

  securityGuard.associate = (models) => {
    models.securityGuard.belongsTo(models.user, {
      as: 'guard',
      constraints: false,
      foreignKey: {
        allowNull: false,
      },
    });

    models.securityGuard.hasMany(models.memos, {
      as: 'memos',
      constraints: false,
      foreignKey: 'guardNameId',
    });

    models.securityGuard.hasMany(models.request, {
      as: 'requests',
      constraints: false,
      foreignKey: 'guardNameId',
    });

    models.securityGuard.hasMany(models.completionOfTutorial, {
      as: 'tutoriales',
      constraints: false,
      foreignKey: 'guardNameId',
    });

    models.securityGuard.hasMany(models.file, {
      as: 'profileImage',
      foreignKey: 'belongsToId',
      constraints: false,
      scope: {
        belongsTo: models.securityGuard.getTableName(),
        belongsToColumn: 'profileImage',
      },
    });

    models.securityGuard.hasMany(models.file, {
      as: 'credentialImage',
      foreignKey: 'belongsToId',
      constraints: false,
      scope: {
        belongsTo: models.securityGuard.getTableName(),
        belongsToColumn: 'credentialImage',
      },
    });

    models.securityGuard.hasMany(models.file, {
      as: 'recordPolicial',
      foreignKey: 'belongsToId',
      constraints: false,
      scope: {
        belongsTo: models.securityGuard.getTableName(),
        belongsToColumn: 'recordPolicial',
      },
    });
    
    models.securityGuard.belongsTo(models.tenant, {
      as: 'tenant',
      foreignKey: {
        allowNull: false,
      },
    });

    models.securityGuard.belongsTo(models.user, {
      as: 'createdBy',
    });

    models.securityGuard.belongsTo(models.user, {
      as: 'updatedBy',
    });
  };

  return securityGuard;
}
