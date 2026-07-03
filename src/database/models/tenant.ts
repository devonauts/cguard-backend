import Plans from '../../security/plans';

const plans = Plans.values;

export default function (sequelize, DataTypes) {
  const tenant = sequelize.define(
    'tenant',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      name: {
        type: DataTypes.STRING(255),
        allowNull: false,
        validation: {
          notEmpty: true,
          len: [0, 255],
        },
      },
      url: {
        type: DataTypes.STRING(50),
        // Allow url to be empty/null until the tenant owner sets a website or subdomain.
        allowNull: true,
        validate: {
          len: [0, 50],
        },
        defaultValue: '',
      },
      plan: {
        type: DataTypes.STRING(255),
        allowNull: false,
        validate: {
          notEmpty: true,
          isIn: [
            [plans.free, plans.growth, plans.enterprise],
          ],
        },
        defaultValue: plans.free,
      },
      planStatus: {
        type: DataTypes.STRING(255),
        allowNull: false,
        validate: {
          notEmpty: true,
          isIn: [
            ['active', 'cancel_at_period_end', 'error'],
          ],
        },
        defaultValue: 'active'
      },
      planStripeCustomerId: {
        type: DataTypes.STRING(255),
        validate: {
          len: [0, 255],
        }
      },
      planUserId: {
        type: DataTypes.UUID,
      },
      // ── Per-user subscription / trial billing ──────────────────────────────
      // When the free trial ends (set on creation to createdAt + trial days).
      trialEndsAt: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      // trialing | active | past_due | trial_expired | canceled
      billingStatus: {
        type: DataTypes.STRING(32),
        allowNull: false,
        defaultValue: 'trialing',
        validate: {
          isIn: [
            ['trialing', 'active', 'past_due', 'trial_expired', 'canceled'],
          ],
        },
      },
      // Active Stripe subscription id once the tenant activates a paid plan.
      stripeSubscriptionId: {
        type: DataTypes.STRING(255),
        allowNull: true,
      },
      // The per-seat subscription item id, so seat quantity can be reconciled.
      stripeSeatItemId: {
        type: DataTypes.STRING(255),
        allowNull: true,
      },
      // Set once the one-time implementation fee has been paid.
      implementationPaidAt: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      // Highest trial-reminder stage already emailed (dedupe). 0 = none.
      trialReminderStage: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
      },
      // Set to true once the tenant owner finishes the first-login business
      // onboarding (business profile + logo). Drives the onboarding banner.
      onboardingCompleted: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      },
      // ── Platform admin lifecycle ───────────────────────────────────────────
      // Set by a superadmin when a tenant is suspended (access blocked). Null =
      // not suspended. Distinct from billingStatus (which Stripe drives) and
      // deletedAt (paranoid soft-delete).
      suspendedAt: {
        type: DataTypes.DATE,
        allowNull: true,
        defaultValue: null,
      },
      suspensionReason: {
        type: DataTypes.STRING(500),
        allowNull: true,
        defaultValue: null,
      },
      // Contact / Business fields added to support invoices/presupuestos
      // Nullable so a self-signup tenant can be created "incomplete" and filled
      // in via the first-login onboarding wizard. The wizard enforces it at the UX layer.
      address: {
        type: DataTypes.TEXT,
        allowNull: true,
        defaultValue: null,
      },
      // Complementary address fields (added 2026)
      addressLine2: {
        type: DataTypes.TEXT,
        allowNull: true,
        defaultValue: null,
      },
      postalCode: {
        type: DataTypes.STRING(50),
        allowNull: true,
        defaultValue: null,
      },
      city: {
        type: DataTypes.STRING(255),
        allowNull: true,
        defaultValue: null,
      },
      country: {
        type: DataTypes.STRING(255),
        allowNull: true,
        defaultValue: null,
      },
      latitude: {
        type: DataTypes.DOUBLE,
        allowNull: true,
        defaultValue: null,
      },
      longitude: {
        type: DataTypes.DOUBLE,
        allowNull: true,
        defaultValue: null,
      },
      phone: {
        type: DataTypes.STRING(50),
        allowNull: true,
        defaultValue: null,
      },
      // Teléfono fijo opcional
      landline: {
        type: DataTypes.STRING(50),
        allowNull: true,
        defaultValue: null,
        validate: {
          len: [0, 50],
        },
      },
      email: {
        type: DataTypes.STRING(255),
        allowNull: false,
        validate: {
          notEmpty: true,
          isEmail: true,
        },
      },
      logoId: {
        type: DataTypes.UUID,
        allowNull: true,
        references: {
          model: 'files',
          key: 'id',
        },
      },
      taxNumber: {
        type: DataTypes.STRING(255),
        allowNull: true,
        defaultValue: null,
      },
      businessTitle: {
        type: DataTypes.STRING(255),
        allowNull: false,
        validate: {
          notEmpty: true,
        },
      },
      extraLines: {
        type: DataTypes.TEXT,
        allowNull: false,
        defaultValue: '',
      },
      website: {
        type: DataTypes.STRING(255),
        allowNull: false,
        validate: {
          len: [0, 255],
        },
        defaultValue: '',
      },
      licenseNumber: {
        type: DataTypes.STRING(255),
        allowNull: false,
        validate: {
          len: [0, 255],
        },
        defaultValue: '',
      },
      timezone: {
        type: DataTypes.STRING(100),
        allowNull: false,
        validate: {
          notEmpty: true,
          // Reject non-IANA values (e.g. "GMT-5", a display name). A bad
          // timezone silently corrupts every wall-clock computation (shift
          // generation, consignas) and crashes unguarded Intl calls in the app.
          isValidTimezone(value: any) {
            if (value == null || value === '') return; // notEmpty handles empties
            try {
              new Intl.DateTimeFormat('en-US', { timeZone: String(value) });
            } catch {
              throw new Error(
                'timezone must be a valid IANA time zone (e.g. America/Guayaquil)',
              );
            }
          },
        },
        defaultValue: 'UTC',
      },
    },
    {
      indexes: [
        {
          unique: true,
          fields: ['url'],
          where: {
            deletedAt: null,
          },
        },
      ],
      timestamps: true,
      paranoid: true,
    },
  );

  // Start the free trial when a tenant is created.
  tenant.beforeCreate((record: any) => {
    if (!record.trialEndsAt) {
      const days = parseInt(process.env.BILLING_TRIAL_DAYS || '', 10);
      const trialDays = Number.isFinite(days) ? days : 14;
      record.trialEndsAt = new Date(Date.now() + trialDays * 24 * 60 * 60 * 1000);
    }
    if (!record.billingStatus) {
      record.billingStatus = 'trialing';
    }
  });

  tenant.associate = (models) => {
    models.tenant.hasMany(models.settings, {
      as: 'settings',
    });

    models.tenant.hasMany(models.tenantUser, {
      as: 'users',
      foreignKey: {
        allowNull: false,
      },
      onDelete: 'CASCADE',
    });

    models.tenant.belongsTo(models.file, {
      as: 'logo',
      foreignKey: 'logoId',
    });

    models.tenant.belongsTo(models.user, {
      as: 'createdBy',
    });

    models.tenant.belongsTo(models.user, {
      as: 'updatedBy',
    });
  };

  return tenant;
}
