import { DataTypes } from 'sequelize';

/**
 * Supervisor profile — the identity/HR record for a security supervisor, the
 * supervisor-side mirror of `securityGuard`. A supervisor is a tenantUser with
 * the `securitySupervisor` role; this row holds their personal data, documents
 * and on-duty flag so the CRM can manage and display a supervisor the same way
 * it does a vigilante, with a bit more (zone of responsibility, assigned
 * vehicle).
 *
 * Keyed on `supervisorUserId` (the user), like supervisorShift — supervisors are
 * NOT securityGuards and never get a securityGuard row (that would pollute the
 * vigilantes list and guard attendance queries).
 */
export default function (sequelize) {
  const supervisorProfile = sequelize.define(
    'supervisorProfile',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      // Denormalized cache synced from the linked user (like securityGuard.fullName).
      fullName: {
        type: DataTypes.STRING(200),
        allowNull: false,
        defaultValue: '',
      },
      governmentId: {
        type: DataTypes.STRING(50),
        allowNull: true,
      },
      gender: { type: DataTypes.TEXT, allowNull: true },
      bloodType: { type: DataTypes.TEXT, allowNull: true },
      birthDate: { type: DataTypes.DATEONLY, allowNull: true },
      birthPlace: { type: DataTypes.STRING(120), allowNull: true },
      maritalStatus: { type: DataTypes.TEXT, allowNull: true },
      academicInstruction: { type: DataTypes.TEXT, allowNull: true },
      address: { type: DataTypes.STRING(200), allowNull: true },
      latitude: { type: DataTypes.DOUBLE, allowNull: true },
      longitude: { type: DataTypes.DOUBLE, allowNull: true },
      hiringContractDate: { type: DataTypes.DATEONLY, allowNull: true },
      guardCredentials: { type: DataTypes.STRING(255), allowNull: true },
      availability: { type: DataTypes.JSON, allowNull: true },
      languages: { type: DataTypes.JSON, allowNull: false, defaultValue: [] },
      skills: { type: DataTypes.JSON, allowNull: false, defaultValue: [] },
      // Denormalized mirror of the supervisor's live clock (supervisorShift).
      isOnDuty: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      // Supervisor-specific: zone/sector of responsibility + assigned vehicle.
      zone: { type: DataTypes.STRING(120), allowNull: true },
      assignedVehicle: { type: DataTypes.STRING(120), allowNull: true },
      // ── Turno (Phase 2) — the recurring shift the supervisor must follow.
      //    turnoDays = weekday numbers 0..6 (0=Sun); turnoStart/End = "HH:mm"
      //    local; mobileStationId = the (mobile) station they patrol from.
      turnoDays: { type: DataTypes.JSON, allowNull: true },
      turnoStart: { type: DataTypes.STRING(5), allowNull: true },
      turnoEnd: { type: DataTypes.STRING(5), allowNull: true },
      mobileStationId: { type: DataTypes.UUID, allowNull: true },
      // Stations/sites this supervisor is responsible for (oversight area).
      // Plain id array — NOT guardAssignment/guardShift (guard-safe, no shift gen).
      assignedStationIds: { type: DataTypes.JSON, allowNull: true },
    },
    {
      timestamps: true,
      paranoid: true,
      indexes: [
        { fields: ['tenantId'] },
        {
          unique: true,
          fields: ['tenantId', 'supervisorUserId'],
          where: { deletedAt: null },
        },
      ],
    },
  );

  supervisorProfile.associate = (models) => {
    supervisorProfile.belongsTo(models.user, {
      as: 'supervisor',
      foreignKey: { name: 'supervisorUserId', allowNull: false },
    });
    supervisorProfile.hasMany(models.file, {
      as: 'profileImage',
      foreignKey: 'belongsToId',
      constraints: false,
      scope: {
        belongsTo: models.supervisorProfile.getTableName(),
        belongsToColumn: 'profileImage',
      },
    });
    supervisorProfile.belongsTo(models.tenant, {
      as: 'tenant',
      foreignKey: { allowNull: false },
    });
    supervisorProfile.belongsTo(models.user, { as: 'createdBy', foreignKey: 'createdById' });
    supervisorProfile.belongsTo(models.user, { as: 'updatedBy', foreignKey: 'updatedById' });
  };

  return supervisorProfile;
}
