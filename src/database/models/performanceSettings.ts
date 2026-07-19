import { DataTypes } from 'sequelize';

/**
 * Per-tenant overrides for the performance-score knobs. Every column is
 * nullable: the scoring service reads this row, then falls back to env vars
 * (PERF_*), then to hardcoded defaults. One row per tenant.
 */
export default function (sequelize) {
  const performanceSettings = sequelize.define(
    'performanceSettings',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      // Factor weights (0..1). Renormalized over factors that have data.
      weightPunctuality: { type: DataTypes.FLOAT, allowNull: true },
      weightUniform: { type: DataTypes.FLOAT, allowNull: true },
      weightInventory: { type: DataTypes.FLOAT, allowNull: true },
      weightConsignas: { type: DataTypes.FLOAT, allowNull: true },
      weightRondas: { type: DataTypes.FLOAT, allowNull: true },
      weightQuiz: { type: DataTypes.FLOAT, allowNull: true },
      weightTraining: { type: DataTypes.FLOAT, allowNull: true },
      // Customer star reviews of the guard (client satisfaction).
      weightClientRating: { type: DataTypes.FLOAT, allowNull: true },
      // Logarithmic absence penalty: K * ln(1 + A*absences + B*tardies)
      penaltyK: { type: DataTypes.FLOAT, allowNull: true },
      penaltyA: { type: DataTypes.FLOAT, allowNull: true },
      penaltyB: { type: DataTypes.FLOAT, allowNull: true },
      // Backup bonus
      volunteerPoints: { type: DataTypes.INTEGER, allowNull: true },
      coverPoints: { type: DataTypes.INTEGER, allowNull: true },
      bonusCap: { type: DataTypes.INTEGER, allowNull: true },
      // Punctuality decay window (minutes)
      graceMinutes: { type: DataTypes.INTEGER, allowNull: true },
      lateFloorMinutes: { type: DataTypes.INTEGER, allowNull: true },
      expectedPatrolsPerShift: { type: DataTypes.INTEGER, allowNull: true },
      active: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: true,
      },
    },
    {
      timestamps: true,
      paranoid: true,
      indexes: [
        {
          unique: true,
          fields: ['tenantId'],
          where: { deletedAt: null },
        },
      ],
    },
  );

  performanceSettings.associate = (models) => {
    performanceSettings.belongsTo(models.tenant, {
      as: 'tenant',
      foreignKey: { allowNull: false },
    });
    performanceSettings.belongsTo(models.user, { as: 'createdBy' });
    performanceSettings.belongsTo(models.user, { as: 'updatedBy' });
  };

  return performanceSettings;
}
