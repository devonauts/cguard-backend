import { QueryInterface, DataTypes } from 'sequelize';

export async function up(queryInterface: QueryInterface) {
  console.log('Starting migration: Add type column to report table...');
  await queryInterface.addColumn('reports', 'type', {
    type: DataTypes.STRING(255),
    allowNull: true,
  });
  console.log('Added type column to report table.');
}

export async function down(queryInterface: QueryInterface) {
  console.log('Reverting migration: Remove type column from report table...');
  await queryInterface.removeColumn('reports', 'type');
  console.log('Removed type column from report table.');
}
