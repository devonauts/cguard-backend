import { DataTypes } from 'sequelize';

/**
 * A graded attempt at a station quiz by a guard or supervisor. The "quiz"
 * factor of the performance score uses the best attempt per period.
 */
export default function (sequelize) {
  const quizAttempt = sequelize.define(
    'quizAttempt',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      total: {
        type: DataTypes.INTEGER,
        allowNull: false,
      },
      correctCount: {
        type: DataTypes.INTEGER,
        allowNull: false,
      },
      scorePct: {
        type: DataTypes.INTEGER, // 0..100
        allowNull: false,
      },
      // JSON: [{ questionId, chosenIndex, correct }]
      answers: {
        type: DataTypes.TEXT,
        allowNull: true,
        get(this: any) {
          const raw = this.getDataValue('answers');
          if (!raw) return [];
          try {
            return JSON.parse(raw);
          } catch {
            return [];
          }
        },
        set(this: any, val: any) {
          this.setDataValue('answers', val == null ? null : JSON.stringify(val));
        },
      },
      startedAt: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      completedAt: {
        type: DataTypes.DATE,
        allowNull: false,
      },
      subjectType: {
        type: DataTypes.ENUM('guard', 'supervisor'),
        allowNull: false,
        defaultValue: 'guard',
      },
    },
    {
      timestamps: true,
      paranoid: true,
      indexes: [
        { fields: ['tenantId', 'subjectUserId', 'completedAt'] },
        { fields: ['tenantId', 'quizBankId'] },
      ],
    },
  );

  quizAttempt.associate = (models) => {
    quizAttempt.belongsTo(models.tenant, {
      as: 'tenant',
      foreignKey: { allowNull: false },
    });
    quizAttempt.belongsTo(models.quizBank, {
      as: 'bank',
      foreignKey: { name: 'quizBankId', allowNull: false },
      constraints: false,
    });
    quizAttempt.belongsTo(models.user, {
      as: 'subject',
      foreignKey: { name: 'subjectUserId', allowNull: false },
      constraints: false,
    });
    quizAttempt.belongsTo(models.securityGuard, {
      as: 'guard',
      foreignKey: { name: 'securityGuardId', allowNull: true },
      constraints: false,
    });
    quizAttempt.belongsTo(models.station, {
      as: 'station',
      foreignKey: { name: 'stationId', allowNull: true },
      constraints: false,
    });
  };

  return quizAttempt;
}
