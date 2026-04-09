module.exports = {
  up: async (queryInterface) => {
    console.log('Force migration: ensure stationId exists on visitorLogs (MySQL friendly)');
    try {
      // Try raw ALTER TABLE to add the column; ignore duplicate errors
      await queryInterface.sequelize.query(
        "ALTER TABLE `visitorLogs` ADD COLUMN `stationId` CHAR(36) NULL;",
      );
      console.log('ALTER TABLE executed: stationId added (or attempted)');
    } catch (err) {
      const msg = (err && err.message) ? err.message : err;
      if (msg && (msg.includes('Duplicate') || msg.includes('duplicate') || msg.includes('ER_DUP_FIELDNAME') || msg.includes('ER_DUP_KEYNAME'))) {
        console.log('Column/Index already exists, skipping');
      } else {
        console.log('Unexpected error while adding stationId:', msg);
      }
    }

    // Try to create index (ignore duplicates)
    try {
      await queryInterface.addIndex('visitorLogs', ['stationId'], { name: 'idx_visitorLogs_stationId' });
    } catch (err) {
      console.log('Index creation skipped or duplicate:', (err && err.message) ? err.message : err);
    }
  },

  down: async (queryInterface) => {
    try {
      await queryInterface.removeColumn('visitorLogs', 'stationId');
    } catch (err) {
      console.log('Down migration: could not remove stationId:', (err && err.message) ? err.message : err);
    }
  },
};
