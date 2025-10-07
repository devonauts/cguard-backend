import Roles from '../../security/roles';
import SequelizeArrayUtils from '../utils/sequelizeArrayUtils';

export default function (sequelize, DataTypes) {
  const tenantUser = sequelize.define(
    'tenantUser',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      roles: {
        type: SequelizeArrayUtils.DataType,
        validate: {
          isValidOption: function (value) {
            if (!value || !value.length) {
              return value;
            }

            // Ensure value is an array
            let arrayValue = value;
            if (!Array.isArray(value)) {
              // If it's a string that looks like JSON, try to parse it
              if (typeof value === 'string' && value.startsWith('[') && value.endsWith(']')) {
                try {
                  arrayValue = JSON.parse(value);
                } catch (e) {
                  throw new Error(`Invalid roles format: ${value}`);
                }
              } else {
                // If it's a single value, wrap it in an array
                arrayValue = [value];
              }
            }

            // Ensure arrayValue is indeed an array at this point
            if (!Array.isArray(arrayValue)) {
              throw new Error(`Roles must be an array, got: ${typeof value}`);
            }
      
            const validOptions: any = Object.keys(Roles.values);
      
            if (
              arrayValue.some(
                (item) => !validOptions.includes(item),
              )
            ) {
              throw new Error(
                `${arrayValue} contains invalid roles. Valid options: ${validOptions.join(', ')}`,
              );
            }
      
            return arrayValue;
          },
        },
      },
      invitationToken: {
        type: DataTypes.STRING(255),
        allowNull: true,
      },
      status: {
        type: DataTypes.STRING(255),
        allowNull: false,
        validate: {
          notEmpty: true,
          isIn: [['active', 'invited', 'empty-permissions']],
        }
      },
    },
    {
      timestamps: true,
      paranoid: true,
    },
  );

  tenantUser.associate = (models) => {
    models.tenantUser.belongsTo(models.tenant, {
      foreignKey: {
        allowNull: false,
      },
    });

    models.tenantUser.belongsTo(models.user, {
      foreignKey: {
        allowNull: false,
      },
    });

    models.tenantUser.belongsTo(models.user, {
      as: 'createdBy',
    });

    models.tenantUser.belongsTo(models.user, {
      as: 'updatedBy',
    });
  };

  return tenantUser;
}
