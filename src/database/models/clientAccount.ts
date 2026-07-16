import { DataTypes } from 'sequelize';

export default function (sequelize) {
  const clientAccount = sequelize.define(
    'clientAccount',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      // DENORMALIZED CACHE, synced from user (user is the single source of
      // identity) — do not edit directly. name/lastName/email/phoneNumber are
      // written exclusively FROM the linked user (clientAccount.userId ->
      // user.id) via identitySync / clientAccountRepository. Before a user is
      // provisioned these act as staging values (see CustomerIdentityService).
      name: {
        type: DataTypes.STRING(200),
        allowNull: false,
        validate: {
          len: [0, 200],
          notEmpty: true,
        }
      },
      // DENORMALIZED CACHE, synced from user — do not edit directly.
      lastName: {
        type: DataTypes.STRING(200),
        allowNull: true,
        validate: {
          len: [0, 200],
        }
      },
      // DENORMALIZED CACHE, synced from user — do not edit directly.
      email: {
        type: DataTypes.STRING(150),
        allowNull: true,
        validate: {
          len: [0, 150],
        }
      },
      personType: {
        type: DataTypes.STRING(3),
        allowNull: true,
        defaultValue: 'PN',
        validate: {
          len: [0, 3],
        }
      },
      documentNumber: {
        type: DataTypes.STRING(50),
        allowNull: true,
        validate: {
          len: [0, 50],
        }
      },
      // DENORMALIZED CACHE, synced from user — do not edit directly.
      phoneNumber: {
        type: DataTypes.STRING(20),
        allowNull: true,
        validate: {
          len: [0, 20],
        }
      },
      address: {
        type: DataTypes.STRING(200),
        allowNull: false,
        validate: {
          len: [0, 200],
          notEmpty: true,
        }
      },
      addressComplement: {
        type: DataTypes.STRING(200),
        allowNull: true,
        validate: {
          len: [0, 200],
        }
      },
      zipCode: {
        type: DataTypes.STRING(20),
        allowNull: true,
        validate: {
          len: [0, 20],
        }
      },
      city: {
        type: DataTypes.STRING(100),
        allowNull: true,
        validate: {
          len: [0, 100],
        }
      },
      country: {
        type: DataTypes.STRING(100),
        allowNull: true,
        validate: {
          len: [0, 100],
        }
      },
      useSameAddressForBilling: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: true,
      },
      faxNumber: {
        type: DataTypes.STRING(20),
        allowNull: true,
        validate: {
          len: [0, 20],
        }
      },
      // New preferred field name: landline. Keep faxNumber for backward compatibility.
      landline: {
        type: DataTypes.STRING(20),
        allowNull: true,
        validate: {
          len: [0, 20],
        }
      },
      website: {
        type: DataTypes.STRING(255),
        allowNull: true,
        validate: {
          len: [0, 255],
        }
      },
      // Contract start date shown/edited in the CRM client form (the input
      // existed but the column didn't — values were silently lost).
      contractDate: {
        type: DataTypes.DATEONLY,
        allowNull: true,
      },
      latitude: {
        type: DataTypes.DECIMAL(10, 8),
        allowNull: true,
      },
      longitude: {
        type: DataTypes.DECIMAL(11, 8),
        allowNull: true,
      },
      importHash: {
        type: DataTypes.STRING(255),
        allowNull: true,
        validate: {
          len: [0, 255],
        },
      },
      userId: {
        type: DataTypes.UUID,
        allowNull: true,
      },
      categoryIds: {
        type: DataTypes.JSON,
        allowNull: true,
        defaultValue: [],
      },
      active: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: true,
      },
      // Business / trade name ("Nombre comercial"). A REAL field now (was a
      // virtual alias of `name`). It is the canonical business name and is used
      // as the label of the client's sitio de servicio.
      commercialName: {
        type: DataTypes.STRING(255),
        allowNull: true,
      },
      onboardingStatus: {
        type: DataTypes.STRING(20),
        allowNull: false,
        defaultValue: 'not_invited',
        // Valid values: not_invited | invited | active | suspended
      },
      // Single-device login: the sid of the ONLY currently-valid client-app session.
      // Set on each customer sign-in; any token whose `sid` differs is superseded (401),
      // so signing in on a new device logs the previous device out.
      activeSessionId: {
        type: DataTypes.STRING(64),
        allowNull: true,
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

  clientAccount.associate = (models) => {
    models.clientAccount.hasMany(models.file, {
      as: 'logoUrl',
      foreignKey: 'belongsToId',
      constraints: false,
      scope: {
        belongsTo: clientAccount.getTableName(),
        belongsToColumn: 'logoUrl',
      },
    });

    models.clientAccount.hasMany(models.file, {
      as: 'placePictureUrl',
      foreignKey: 'belongsToId',
      constraints: false,
      scope: {
        belongsTo: clientAccount.getTableName(),
        belongsToColumn: 'placePictureUrl',
      },
    });

    // Multi-tenant relationship
    models.clientAccount.belongsTo(models.tenant, {
      as: 'tenant',
      foreignKey: {
        allowNull: false,
      },
    });

    // Audit relationships
    models.clientAccount.belongsTo(models.user, {
      as: 'createdBy',
    });

    models.clientAccount.belongsTo(models.user, {
      as: 'updatedBy',
    });

    // Assign clients to tenantUsers
    models.clientAccount.belongsToMany(models.tenantUser, {
      through: 'tenant_user_client_accounts',
      foreignKey: 'clientAccountId',
      otherKey: 'tenantUserId',
      as: 'assignedTenantUsers',
      constraints: false,
    });

    // Link to the User record representing the client (optional)
    models.clientAccount.belongsTo(models.user, {
      as: 'user',
      foreignKey: 'userId',
    });
  };

  return clientAccount;
}