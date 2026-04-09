import { DataTypes } from 'sequelize';

module.exports = {
  up: async (queryInterface) => {
    console.log('Starting migration: add tenantId to siteTours and siteTourTags...');

    // siteTours
    const siteToursDesc = await queryInterface.describeTable('siteTours').catch(() => null);
    if (!siteToursDesc) {
      console.log('Table siteTours does not exist; skipping siteTours changes');
    } else if (!siteToursDesc['tenantId']) {
      console.log('Adding tenantId column to siteTours');
      await queryInterface.addColumn('siteTours', 'tenantId', {
        type: DataTypes.UUID,
        allowNull: true,
      });

      // add index for tenantId if not present
      const stIndexes = await queryInterface.showIndex('siteTours').catch(() => []);
      const stIndexNames = (stIndexes || []).map((i) => i.name).filter(Boolean);
      if (!stIndexNames.includes('idx_siteTours_tenantId')) {
        await queryInterface.addIndex('siteTours', ['tenantId'], { name: 'idx_siteTours_tenantId' });
      }

      // Backfill tenantId from businessInfos (postSite -> businessInfos.tenantId)
      try {
        await queryInterface.sequelize.query(`
          UPDATE siteTours st
          JOIN businessInfos b ON st.postSiteId = b.id
          SET st.tenantId = b.tenantId
          WHERE (st.tenantId IS NULL OR st.tenantId = '') AND b.tenantId IS NOT NULL
        `);
        console.log('Backfilled siteTours.tenantId from businessInfos');
      } catch (e: any) {
        console.warn('Backfill siteTours.tenantId failed:', e && e.message ? e.message : e);
      }
    } else {
      console.log('siteTours.tenantId already exists, skipping');
    }

    // siteTourTags
    const tagsDesc = await queryInterface.describeTable('siteTourTags').catch(() => null);
    if (!tagsDesc) {
      console.log('Table siteTourTags does not exist; skipping siteTourTags changes');
    } else if (!tagsDesc['tenantId']) {
      console.log('Adding tenantId column to siteTourTags');
      await queryInterface.addColumn('siteTourTags', 'tenantId', {
        type: DataTypes.UUID,
        allowNull: true,
      });

      const idxs = await queryInterface.showIndex('siteTourTags').catch(() => []);
      const idxNames = (idxs || []).map((i) => i.name).filter(Boolean);
      if (!idxNames.includes('idx_siteTourTags_tenantId')) {
        await queryInterface.addIndex('siteTourTags', ['tenantId'], { name: 'idx_siteTourTags_tenantId' });
      }

      // Backfill tenantId on tags from their siteTour
      try {
        await queryInterface.sequelize.query(`
          UPDATE siteTourTags t
          JOIN siteTours st ON t.siteTourId = st.id
          SET t.tenantId = st.tenantId
          WHERE (t.tenantId IS NULL OR t.tenantId = '') AND st.tenantId IS NOT NULL
        `);
        console.log('Backfilled siteTourTags.tenantId from siteTours');
      } catch (e: any) {
        console.warn('Backfill siteTourTags.tenantId failed:', e && e.message ? e.message : e);
      }
    } else {
      console.log('siteTourTags.tenantId already exists, skipping');
    }

    console.log('Migration completed: add tenantId to siteTours and siteTourTags');
  },

  down: async (queryInterface) => {
    console.log('Reverting migration: remove tenantId from siteTourTags and siteTours (if exists)');

    const tagsDesc = await queryInterface.describeTable('siteTourTags').catch(() => null);
    if (tagsDesc && tagsDesc['tenantId']) {
      const idxs = await queryInterface.showIndex('siteTourTags').catch(() => []);
      const idxNames = (idxs || []).map((i) => i.name).filter(Boolean);
      if (idxNames.includes('idx_siteTourTags_tenantId')) {
        await queryInterface.removeIndex('siteTourTags', 'idx_siteTourTags_tenantId').catch(() => {});
      }
      await queryInterface.removeColumn('siteTourTags', 'tenantId').catch(() => {});
      console.log('Removed tenantId from siteTourTags');
    }

    const stDesc = await queryInterface.describeTable('siteTours').catch(() => null);
    if (stDesc && stDesc['tenantId']) {
      const stIndexes = await queryInterface.showIndex('siteTours').catch(() => []);
      const stIndexNames = (stIndexes || []).map((i) => i.name).filter(Boolean);
      if (stIndexNames.includes('idx_siteTours_tenantId')) {
        await queryInterface.removeIndex('siteTours', 'idx_siteTours_tenantId').catch(() => {});
      }
      await queryInterface.removeColumn('siteTours', 'tenantId').catch(() => {});
      console.log('Removed tenantId from siteTours');
    }

    console.log('Revert completed');
  },
};
