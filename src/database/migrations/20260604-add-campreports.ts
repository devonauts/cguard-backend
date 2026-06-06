import { DataTypes } from 'sequelize';

export async function up(queryInterface, Sequelize) {
  await queryInterface.addColumn('reports', 'type', {
    type: DataTypes.STRING,
    allowNull: false,
    defaultValue: 'other',
  });
}

export async function down(queryInterface, Sequelize) {
  await queryInterface.removeColumn('reports', 'type');
}