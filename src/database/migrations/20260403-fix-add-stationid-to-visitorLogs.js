const { DataTypes } = require('sequelize');

module.exports = {
  up: async (queryInterface) => {
    console.log('Fix migration: ensure stationId column exists on visitorLogs');

    // Try describeTable; if it fails, we'll still attempt to add the column and catch errors
    let tableDesc = null;
    try {
      tableDesc = await queryInterface.describeTable('visitorLogs');
    } catch (err) {
      console.log('describeTable failed:', err.message || err);
    }

    const hasColumn = tableDesc && Object.prototype.hasOwnProperty.call(tableDesc, 'stationId');

    if (!hasColumn) {
      try {
        console.log('Adding stationId column to visitorLogs (fix migration)');
        await queryInterface.addColumn('visitorLogs', 'stationId', {
          type: DataTypes.UUID,
          allowNull: true,
        });
      } catch (err) {
        console.log('addColumn failed, attempting raw ALTER TABLE as fallback:', err.message || err);
        try {
          // Fallback: try raw SQL alter. This may differ between DB engines but commonly works for MySQL/Postgres.
          await queryInterface.sequelize.query(
            `ALTER TABLE "visitorLogs" ADD COLUMN IF NOT EXISTS "stationId" UUID NULL;`,
          );
        } catch (err2) {
          // Try without quotes for MySQL-like setups
          try {
            await queryInterface.sequelize.query(
              'ALTER TABLE visitorLogs ADD COLUMN IF NOT EXISTS stationId CHAR(36) NULL;',
            );
          } catch (err3) {
            console.log('Fallback ALTER TABLE attempts failed:', err2.message || err2, err3.message || err3);
          }
        }
      }
    } else {
      console.log('visitorLogs.stationId already present, nothing to do');
    }

    // Ensure indexes exist
    try {
      const indexes = await queryInterface.showIndex('visitorLogs').catch(() => []);
      const indexNames = (indexes || []).map((i) => i.name).filter(Boolean);

      if (!indexNames.includes('idx_visitorLogs_stationId')) {
        await queryInterface.addIndex('visitorLogs', ['stationId'], { name: 'idx_visitorLogs_stationId' });
      }

      if (!indexNames.includes('idx_visitorLogs_stationId_tenantId')) {
        await queryInterface.addIndex('visitorLogs', ['stationId', 'tenantId'], { name: 'idx_visitorLogs_stationId_tenantId' });
      }
    } catch (err) {
      console.log('Index creation skipped or failed:', err.message || err);
    }

    console.log('Fix migration completed');
  },

  down: async (queryInterface) => {
    try {
      const tableDesc = await queryInterface.describeTable('visitorLogs').catch(() => null);
      if (tableDesc && Object.prototype.hasOwnProperty.call(tableDesc, 'stationId')) {
        await queryInterface.removeColumn('visitorLogs', 'stationId');
      }
    } catch (err) {
      console.log('Down migration: could not remove stationId:', err.message || err);
    }
  },
};
