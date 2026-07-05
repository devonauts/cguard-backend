import { DataTypes } from 'sequelize';

/**
 * "Puesto de supervisor" — a supervisor POSITION (e.g. "Aguila2"), configured
 * like a guard station: a rotation style (día/noche/descanso) + a shift window.
 * Supervisors are ASSIGNED to it (supervisorPositionAssignment) and follow its
 * rotation — the schedule lives HERE, never on the individual user.
 *
 * Fully isolated from the guard engine (no stationPosition/guardAssignment/shift):
 * it only reuses the guard-agnostic `rotationStyle` table for the día/noche/rest
 * pattern.
 */
export default function (sequelize) {
  const supervisorPosition = sequelize.define(
    'supervisorPosition',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      name: { type: DataTypes.STRING(120), allowNull: false },
      zone: { type: DataTypes.STRING(120), allowNull: true },
      // Coverage shape: 12h-day | 12h-night | 24h | custom (mirrors station.scheduleType).
      scheduleType: { type: DataTypes.STRING(20), allowNull: false, defaultValue: '24h' },
      // Reuse the shared rotationStyle table (dayShifts/nightShifts/restDays).
      rotationStyleId: { type: DataTypes.UUID, allowNull: true },
      // Día shift window "HH:mm"; the noche window is the swap (like the guard engine).
      startTime: { type: DataTypes.STRING(5), allowNull: true },
      endTime: { type: DataTypes.STRING(5), allowNull: true },
      // How many supervisors are needed to cover a slot (día/noche).
      guardsNeeded: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
      // Optional link to a mobile station this puesto patrols from.
      mobileStationId: { type: DataTypes.UUID, allowNull: true },
      isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      tenantId: {
        type: DataTypes.UUID,
        allowNull: false,
        references: { model: 'tenants', key: 'id' },
      },
      createdById: { type: DataTypes.UUID, references: { model: 'users', key: 'id' } },
      updatedById: { type: DataTypes.UUID, references: { model: 'users', key: 'id' } },
    },
    {
      indexes: [{ fields: ['tenantId'] }],
      timestamps: true,
      paranoid: true,
    },
  );

  supervisorPosition.associate = (models) => {
    supervisorPosition.belongsTo(models.rotationStyle, { as: 'rotationStyle', foreignKey: { name: 'rotationStyleId' } });
    supervisorPosition.belongsTo(models.tenant, { as: 'tenant', foreignKey: { allowNull: false, name: 'tenantId' } });
    supervisorPosition.belongsTo(models.user, { as: 'createdBy' });
    supervisorPosition.belongsTo(models.user, { as: 'updatedBy' });
    supervisorPosition.hasMany(models.supervisorPositionAssignment, { as: 'assignments', foreignKey: 'positionId' });
  };

  return supervisorPosition;
}
