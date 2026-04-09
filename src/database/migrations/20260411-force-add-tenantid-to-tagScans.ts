module.exports = {
  up: async (queryInterface) => {
    console.log('Starting forced migration: ensure tenantId exists on tagScans (raw SQL)');

    const desc = await queryInterface.describeTable('tagScans').catch(() => null);
    if (!desc) {
      console.log('Table tagScans does not exist; skipping');
      return;
    }

    // case-insensitive check
    const keys = Object.keys(desc || {}).map((k) => String(k).toLowerCase());
    if (!keys.includes('tenantid')) {
      try {
        console.log('Adding tenantId (CHAR(36) BINARY) to tagScans via raw ALTER TABLE');
        await queryInterface.sequelize.query(`ALTER TABLE tagScans ADD COLUMN tenantId CHAR(36) BINARY NULL`);
      } catch (err) {
        console.warn('Raw ALTER TABLE failed (may already exist or insufficient privileges):', err && err.message ? err.message : err);
      }
    } else {
      console.log('tenantId already present on tagScans');
    }

    // ensure index exists
    try {
      const idxs = await queryInterface.showIndex('tagScans').catch(() => []);
      const idxNames = (idxs || []).map((i) => (i && i.name ? String(i.name) : '')).filter(Boolean).map((n) => n.toLowerCase());
      if (!idxNames.includes('idx_tagscans_tenantid')) {
        try {
          await queryInterface.sequelize.query(`CREATE INDEX idx_tagScans_tenantId ON tagScans (tenantId)`);
          console.log('Created index idx_tagScans_tenantId');
        } catch (err) {
          console.warn('Create index failed or already exists:', err && err.message ? err.message : err);
        }
      } else {
        console.log('Index idx_tagScans_tenantId already present');
      }
    } catch (e) {
      console.warn('Index check failed:', e && e.message ? e.message : e);
    }

    // backfill from siteTourTags
    try {
      await queryInterface.sequelize.query(`
        UPDATE tagScans ts
        JOIN siteTourTags t ON ts.siteTourTagId = t.id
        SET ts.tenantId = t.tenantId
        WHERE (ts.tenantId IS NULL OR ts.tenantId = '') AND t.tenantId IS NOT NULL
      `);
      console.log('Backfilled tagScans.tenantId from siteTourTags (if any)');
    } catch (err) {
      console.warn('Backfill from siteTourTags failed:', err && err.message ? err.message : err);
    }

    // fallback backfill from businessInfos via postSiteId
    try {
      await queryInterface.sequelize.query(`
        UPDATE tagScans ts
        JOIN businessInfos b ON ts.postSiteId = b.id
        SET ts.tenantId = b.tenantId
        WHERE (ts.tenantId IS NULL OR ts.tenantId = '') AND b.tenantId IS NOT NULL
      `);
      console.log('Backfilled tagScans.tenantId from businessInfos (postSite)');
    } catch (err) {
      console.warn('Backfill from businessInfos failed:', err && err.message ? err.message : err);
    }
  },

  down: async (queryInterface) => {
    console.log('Reverting forced tenantId migration for tagScans');
    const desc = await queryInterface.describeTable('tagScans').catch(() => null);
    if (desc && desc.tenantId) {
      try {
        await queryInterface.sequelize.query('DROP INDEX idx_tagScans_tenantId ON tagScans').catch(() => {});
      } catch (e) {}
      try {
        await queryInterface.sequelize.query('ALTER TABLE tagScans DROP COLUMN tenantId');
      } catch (e) {}
    }
  },
};
