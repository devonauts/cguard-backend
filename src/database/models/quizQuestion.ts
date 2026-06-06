import { DataTypes } from 'sequelize';

/**
 * A single multiple-choice question in a station's quiz bank.
 *
 * SECURITY: `correctIndex` must never be returned to a guard taking the quiz.
 * The guard-facing endpoint sanitizes questions to {id, prompt, options} only.
 */
export default function (sequelize) {
  const quizQuestion = sequelize.define(
    'quizQuestion',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      prompt: {
        type: DataTypes.TEXT,
        allowNull: false,
      },
      // JSON array of option strings.
      options: {
        type: DataTypes.TEXT,
        allowNull: false,
        get(this: any) {
          const raw = this.getDataValue('options');
          if (!raw) return [];
          try {
            return JSON.parse(raw);
          } catch {
            return [];
          }
        },
        set(this: any, val: any) {
          this.setDataValue('options', val == null ? '[]' : JSON.stringify(val));
        },
      },
      correctIndex: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
      },
      weight: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 1,
      },
      active: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: true,
      },
    },
    {
      timestamps: true,
      paranoid: true,
      indexes: [{ fields: ['tenantId', 'quizBankId'] }],
    },
  );

  quizQuestion.associate = (models) => {
    quizQuestion.belongsTo(models.tenant, {
      as: 'tenant',
      foreignKey: { allowNull: false },
    });
    quizQuestion.belongsTo(models.quizBank, {
      as: 'bank',
      foreignKey: { name: 'quizBankId', allowNull: false },
      constraints: false,
    });
    quizQuestion.belongsTo(models.user, { as: 'createdBy' });
    quizQuestion.belongsTo(models.user, { as: 'updatedBy' });
  };

  return quizQuestion;
}
