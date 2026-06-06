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
