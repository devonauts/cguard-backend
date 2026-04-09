import { DataTypes } from 'sequelize';

module.exports = {
  up: async (queryInterface) => {
    console.log('Starting migration: add stationId to visitorLogs...');
    // check if table exists and column not present
    const tableDesc = await queryInterface.describeTable('visitorLogs').catch(() => null);
    if (!tableDesc) {
      console.log('Table visitorLogs does not exist; skipping migration');
      return;
    }

    if (!tableDesc['stationId']) {
      console.log('Adding stationId column to visitorLogs');
      await queryInterface.addColumn('visitorLogs', 'stationId', {
        type: DataTypes.UUID,
        allowNull: true,
      });
    } else {
      console.log('visitorLogs.stationId already exists, skipping');
    }

    // add index for faster lookups by stationId and composite with tenantId
    const indexes = await queryInterface.showIndex('visitorLogs').catch(() => []);
    const indexNames = (indexes || []).map((i) => i.name).filter(Boolean);

    if (!indexNames.includes('idx_visitorLogs_stationId')) {
      await queryInterface.addIndex('visitorLogs', ['stationId'], { name: 'idx_visitorLogs_stationId' });
    }

    if (!indexNames.includes('idx_visitorLogs_stationId_tenantId')) {
      await queryInterface.addIndex('visitorLogs', ['stationId', 'tenantId'], { name: 'idx_visitorLogs_stationId_tenantId' });
    }

    console.log('Migration completed: add stationId to visitorLogs');
  },

  down: async (queryInterface) => {
    const tableDesc = await queryInterface.describeTable('visitorLogs').catch(() => null);
    if (!tableDesc) return;

    const indexes = await queryInterface.showIndex('visitorLogs').catch(() => []);
    const indexNames = (indexes || []).map((i) => i.name).filter(Boolean);
    if (indexNames.includes('idx_visitorLogs_stationId')) {
      await queryInterface.removeIndex('visitorLogs', 'idx_visitorLogs_stationId');
    }
    if (indexNames.includes('idx_visitorLogs_stationId_tenantId')) {
      await queryInterface.removeIndex('visitorLogs', 'idx_visitorLogs_stationId_tenantId');
    }

    if (tableDesc['stationId']) {
      await queryInterface.removeColumn('visitorLogs', 'stationId');
    }
  },
};
