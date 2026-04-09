import { DataTypes } from 'sequelize';

module.exports = {
  up: async (queryInterface) => {
    console.log('Starting migration: add stationId to tagScans...');

    const tableDesc = await queryInterface.describeTable('tagScans').catch(() => null);
    if (!tableDesc) {
      console.log('Table tagScans does not exist; skipping migration');
      return;
    }

    if (!tableDesc['stationId']) {
      console.log('Adding stationId column to tagScans');
      await queryInterface.addColumn('tagScans', 'stationId', {
        type: DataTypes.UUID,
        allowNull: true,
      });
    } else {
      console.log('tagScans.stationId already exists, skipping');
    }

    const indexes = await queryInterface.showIndex('tagScans').catch(() => []);
    const indexNames = (indexes || []).map((i) => i.name).filter(Boolean);

    if (!indexNames.includes('idx_tagScans_stationId')) {
      await queryInterface.addIndex('tagScans', ['stationId'], { name: 'idx_tagScans_stationId' });
    }

    console.log('Migration completed: add stationId to tagScans');
  },

  down: async (queryInterface) => {
    const tableDesc = await queryInterface.describeTable('tagScans').catch(() => null);
    if (!tableDesc) return;

    const indexes = await queryInterface.showIndex('tagScans').catch(() => []);
    const indexNames = (indexes || []).map((i) => i.name).filter(Boolean);
    if (indexNames.includes('idx_tagScans_stationId')) {
      await queryInterface.removeIndex('tagScans', 'idx_tagScans_stationId');
    }

    if (tableDesc['stationId']) {
      await queryInterface.removeColumn('tagScans', 'stationId');
    }
  },
};
