import { DataTypes } from 'sequelize';

module.exports = {
  up: async (queryInterface) => {
    console.log('Starting migration: add tenantId to tagScans...');

    const desc = await queryInterface.describeTable('tagScans').catch(() => null);
    if (!desc) {
      console.log('Table tagScans does not exist; skipping');
      return;
    }

    // use case-insensitive check for existing column names
    const descKeys = Object.keys(desc || {}).map((k) => String(k).toLowerCase());
    if (!descKeys.includes('tenantid')) {
      console.log('Adding tenantId column to tagScans');
      try {
        await queryInterface.addColumn('tagScans', 'tenantId', {
          type: DataTypes.UUID,
          allowNull: true,
        });
        console.log('Added tenantId column to tagScans');
      } catch (err: any) {
        // ignore duplicate column errors (another process may have added it)
        const msg = err && err.message ? err.message : String(err);
        if (msg.includes('Duplicate column') || (err && err.parent && (err.parent.code === 'ER_DUP_FIELDNAME' || err.parent.errno === 1060))) {
          console.warn('tenantId column already present (race or previous run), continuing');
        } else {
          console.warn('Error adding tenantId to tagScans, continuing:', msg);
        }
      }

      // add index if missing (case-insensitive)
      const idxs = await queryInterface.showIndex('tagScans').catch(() => []);
      const idxNames = (idxs || []).map((i) => (i && i.name ? String(i.name) : '')).filter(Boolean).map((n) => n.toLowerCase());
      if (!idxNames.includes('idx_tagscans_tenantid')) {
        try {
          await queryInterface.addIndex('tagScans', ['tenantId'], { name: 'idx_tagScans_tenantId' });
          console.log('Added index idx_tagScans_tenantId');
        } catch (err: any) {
          const msg = err && err.message ? err.message : String(err);
          if (msg.includes('Duplicate key name') || (err && err.parent && (err.parent.code === 'ER_DUP_KEYNAME' || err.parent.errno === 1061))) {
            console.warn('Index idx_tagScans_tenantId already exists, skipping');
          } else {
            console.warn('Error creating index idx_tagScans_tenantId:', msg);
          }
        }
      }

      // Backfill from siteTourTags -> siteTours (prefer tag's tenant if available)
      try {
        await queryInterface.sequelize.query(`
          UPDATE tagScans ts
          JOIN siteTourTags t ON ts.siteTourTagId = t.id
          SET ts.tenantId = t.tenantId
          WHERE (ts.tenantId IS NULL OR ts.tenantId = '') AND t.tenantId IS NOT NULL
        `);
        console.log('Backfilled tagScans.tenantId from siteTourTags');
      } catch (e: any) {
        console.warn('Backfill from siteTourTags failed:', e && e.message ? e.message : e);
      }

      // If still null, try backfilling from businessInfos via postSiteId
      try {
        await queryInterface.sequelize.query(`
          UPDATE tagScans ts
          JOIN businessInfos b ON ts.postSiteId = b.id
          SET ts.tenantId = b.tenantId
          WHERE (ts.tenantId IS NULL OR ts.tenantId = '') AND b.tenantId IS NOT NULL
        `);
        console.log('Backfilled tagScans.tenantId from businessInfos (postSite)');
      } catch (e: any) {
        console.warn('Backfill from businessInfos failed:', e && e.message ? e.message : e);
      }
    } else {
      console.log('tagScans.tenantId already exists, skipping');
    }

    console.log('Migration completed: add tenantId to tagScans');
  },

  down: async (queryInterface) => {
    console.log('Reverting migration: remove tenantId from tagScans (if exists)');
    const desc = await queryInterface.describeTable('tagScans').catch(() => null);
    if (desc && desc['tenantId']) {
      const idxs = await queryInterface.showIndex('tagScans').catch(() => []);
      const idxNames = (idxs || []).map((i) => i.name).filter(Boolean);
      if (idxNames.includes('idx_tagScans_tenantId')) {
        await queryInterface.removeIndex('tagScans', 'idx_tagScans_tenantId').catch(() => {});
      }
      await queryInterface.removeColumn('tagScans', 'tenantId').catch(() => {});
      console.log('Removed tenantId from tagScans');
    }
    console.log('Revert completed');
  },
};
