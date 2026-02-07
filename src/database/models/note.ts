import { DataTypes } from 'sequelize';

export default function (sequelize) {
  const note = sequelize.define(
    'note',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      title: {
        type: DataTypes.STRING(200),
        allowNull: false,
        validate: { len: [0, 200] },
      },
      description: {
        type: DataTypes.TEXT,
        allowNull: false,
      },
      noteDate: {
        type: DataTypes.DATEONLY,
        allowNull: true,
      },
      attachment: {
        type: DataTypes.JSON,
        allowNull: true,
      },
      notableType: {
        type: DataTypes.STRING(100),
        allowNull: false,
      },
      notableId: {
        type: DataTypes.UUID,
        allowNull: false,
      },

    },
    {
      timestamps: true,
      paranoid: true,
    },
  );

  note.associate = (models) => {
    models.note.belongsTo(models.tenant, {
      as: 'tenant',
      foreignKey: { allowNull: false },
    });

    models.note.belongsTo(models.user, { as: 'createdBy' });
    models.note.belongsTo(models.user, { as: 'updatedBy' });
  };

  return note;
}