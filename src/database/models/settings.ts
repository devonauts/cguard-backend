export default function (sequelize, DataTypes) {
  const settings = sequelize.define(
    'settings',
    {
      id: {
        type: DataTypes.STRING,
        defaultValue: 'default',
        primaryKey: true,
      },
      theme: {
        type: DataTypes.STRING(255),
        allowNull: false,
        validate: {
          notEmpty: true,
          len: [0, 255],
        },
      },
      backgroundImageUrl: {
        type: DataTypes.STRING(1024),
      },
      logoUrl: {
        type: DataTypes.STRING(1024),
      },
      // When false, adding a client does NOT auto-send the portal welcome/invitation
      // email. Admins can still send it manually via "Enviar acceso a la app".
      // (Legacy single-toggle — superseded by emailPreferences.clientWelcome.)
      clientWelcomeEmailEnabled: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: true,
      },
      // Per-tenant on/off map for every email the platform sends, keyed by the
      // keys in src/lib/emailCatalog.ts. Stored as JSON text. Missing key = ON.
      emailPreferences: {
        type: DataTypes.TEXT,
        allowNull: true,
        get(this: any) {
          const raw = this.getDataValue('emailPreferences');
          if (!raw) return {};
          if (typeof raw !== 'string') return raw;
          try {
            return JSON.parse(raw);
          } catch {
            return {};
          }
        },
        set(this: any, val: any) {
          this.setDataValue(
            'emailPreferences',
            val == null ? null : typeof val === 'string' ? val : JSON.stringify(val),
          );
        },
      },
      // Per-tenant transactional-email branding (accent + header color) applied
      // to the shared email shell (lib/emailLayout.ts). JSON text:
      // { brandColor?: '#RRGGBB', headerColor?: '#RRGGBB' }. Missing = defaults
      // (gold accent / navy header). Logo reuses settings.logoUrl.
      emailBranding: {
        type: DataTypes.TEXT,
        allowNull: true,
        get(this: any) {
          const raw = this.getDataValue('emailBranding');
          if (!raw) return {};
          if (typeof raw !== 'string') return raw;
          try {
            return JSON.parse(raw);
          } catch {
            return {};
          }
        },
        set(this: any, val: any) {
          this.setDataValue(
            'emailBranding',
            val == null ? null : typeof val === 'string' ? val : JSON.stringify(val),
          );
        },
      },
      // Per-tenant notification-channel map (Configuración → Notificaciones),
      // keyed by row id: { [rowId]: { dashboard, email, sms } }. JSON text.
      notificationPreferences: {
        type: DataTypes.TEXT,
        allowNull: true,
        get(this: any) {
          const raw = this.getDataValue('notificationPreferences');
          if (!raw) return {};
          if (typeof raw !== 'string') return raw;
          try {
            return JSON.parse(raw);
          } catch {
            return {};
          }
        },
        set(this: any, val: any) {
          this.setDataValue(
            'notificationPreferences',
            val == null ? null : typeof val === 'string' ? val : JSON.stringify(val),
          );
        },
      },
      // Team mobile hub: per-tenant customization of the worker & supervisor
      // apps (accent color, display name/tagline, logo toggle, default theme,
      // module visibility). JSON text; defaults merged in code
      // (services/mobileAppSettingsService.ts). Missing key = default.
      mobileAppSettings: {
        type: DataTypes.TEXT,
        allowNull: true,
        get(this: any) {
          const raw = this.getDataValue('mobileAppSettings');
          if (!raw) return {};
          if (typeof raw !== 'string') return raw;
          try {
            return JSON.parse(raw);
          } catch {
            return {};
          }
        },
        set(this: any, val: any) {
          this.setDataValue(
            'mobileAppSettings',
            val == null ? null : typeof val === 'string' ? val : JSON.stringify(val),
          );
        },
      },
      // Per-tenant unified-communications configuration (channel toggles, OTP
      // preference, wallet rules, per-event toggles). JSON text; defaults are
      // merged in code (see services/communication/communicationSettingsService.ts).
      // Missing key = default.
      communicationSettings: {
        type: DataTypes.TEXT,
        allowNull: true,
        get(this: any) {
          const raw = this.getDataValue('communicationSettings');
          if (!raw) return {};
          if (typeof raw !== 'string') return raw;
          try {
            return JSON.parse(raw);
          } catch {
            return {};
          }
        },
        set(this: any, val: any) {
          this.setDataValue(
            'communicationSettings',
            val == null ? null : typeof val === 'string' ? val : JSON.stringify(val),
          );
        },
      },
      // Per-tenant Nómina / Time & Attendance configuration (general, time
      // windows, geofence, notifications, approval rules, payroll). JSON text;
      // defaults are merged in code (see lib/nominaSettings.ts). Missing = default.
      nominaSettings: {
        type: DataTypes.TEXT,
        allowNull: true,
        get(this: any) {
          const raw = this.getDataValue('nominaSettings');
          if (!raw) return {};
          if (typeof raw !== 'string') return raw;
          try {
            return JSON.parse(raw);
          } catch {
            return {};
          }
        },
        set(this: any, val: any) {
          this.setDataValue(
            'nominaSettings',
            val == null ? null : typeof val === 'string' ? val : JSON.stringify(val),
          );
        },
      },
    },
    {
      timestamps: true,
      paranoid: true,
    },
  );

  settings.associate = (models) => {
    models.settings.hasMany(models.file, {
      as: 'logos',
      foreignKey: 'belongsToId',
      constraints: false,
      scope: {
        belongsTo: models.settings.getTableName(),
        belongsToColumn: 'logos',
      },
    });

    models.settings.hasMany(models.file, {
      as: 'backgroundImages',
      foreignKey: 'belongsToId',
      constraints: false,
      scope: {
        belongsTo: models.settings.getTableName(),
        belongsToColumn: 'backgroundImages',
      },
    });

    models.settings.hasMany(models.file, {
      as: 'legalDocuments',
      foreignKey: 'belongsToId',
      constraints: false,
      scope: {
        belongsTo: models.settings.getTableName(),
        belongsToColumn: 'legalDocuments',
      },
    });

    models.settings.belongsTo(models.tenant, {
      as: 'tenant',
      foreignKey: {
        allowNull: false,
      },
    });

    models.settings.belongsTo(models.user, {
      as: 'createdBy',
    });

    models.settings.belongsTo(models.user, {
      as: 'updatedBy',
    });
  };

  return settings;
}
