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
          isValidOption: async function (value) {
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
      
            // Start with built-in roles
            const validOptions: any = Object.keys(Roles.values);

            // If tenantId is present, also include dynamic role slugs from the DB
            try {
              const tenantIdVal = (this as any).tenantId;
              if (tenantIdVal && tenantIdVal !== '') {
                const roleRecords = await sequelize.models.role.findAll({
                  where: { tenantId: tenantIdVal },
                  attributes: ['slug'],
                });
                roleRecords.forEach((r) => {
                  if (r && r.slug) validOptions.push(r.slug);
                });
              }
            } catch (e) {
              // If DB isn't available during validation, silently proceed with built-in roles only
            }

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
      invitationTokenExpiresAt: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      status: {
        type: DataTypes.STRING(255),
        allowNull: false,
        validate: {
          notEmpty: true,
          // include 'archived' and 'pending' as valid tenant user statuses
          isIn: [['active', 'invited', 'pending', 'archived']],
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
      onDelete: 'CASCADE',
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

    // Relations to clients and postSites via pivot tables
    models.tenantUser.belongsToMany(models.clientAccount, {
      through: 'tenant_user_client_accounts',
      foreignKey: 'tenantUserId',
      otherKey: 'clientAccountId',
      as: 'assignedClients',
      constraints: false,
    });

    models.tenantUser.belongsToMany(models.businessInfo, {
      through: 'tenant_user_post_sites',
      foreignKey: 'tenantUserId',
      otherKey: 'businessInfoId',
      as: 'assignedPostSites',
      constraints: false,
    });
  };

  return tenantUser;
}
