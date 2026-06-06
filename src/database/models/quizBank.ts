import { DataTypes } from 'sequelize';

/**
 * A per-station bank of security questions. A guard's "random 10-question test
 * about the station" is built by sampling `questionsPerAttempt` active
 * questions from this bank. Feeds the "quiz" factor of the performance score.
 */
export default function (sequelize) {
  const quizBank = sequelize.define(
    'quizBank',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      title: {
        type: DataTypes.STRING(255),
        allowNull: true,
      },
      questionsPerAttempt: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 10,
      },
      passPct: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 70,
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
      indexes: [
        {
          unique: true,
          fields: ['tenantId', 'stationId'],
          where: { deletedAt: null },
        },
      ],
    },
  );

  quizBank.associate = (models) => {
    quizBank.belongsTo(models.tenant, {
      as: 'tenant',
      foreignKey: { allowNull: false },
    });
    quizBank.belongsTo(models.station, {
      as: 'station',
      foreignKey: { name: 'stationId', allowNull: false },
      constraints: false,
    });
    quizBank.hasMany(models.quizQuestion, {
      as: 'questions',
      foreignKey: 'quizBankId',
      constraints: false,
    });
    quizBank.belongsTo(models.user, { as: 'createdBy' });
    quizBank.belongsTo(models.user, { as: 'updatedBy' });
  };

  return quizBank;
}
