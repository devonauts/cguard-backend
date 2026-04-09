import models from '../database/models';
import { v4 as uuidv4 } from 'uuid';

(async () => {
  const db = models();
  try {
    const postSiteId = 'a5fbe689-3ae9-4e6f-a5a0-0b8c2ea9f624';
    console.log('Looking up postSite', postSiteId);
    const post = await db.businessInfo.findOne({ where: { id: postSiteId } });
    if (!post) {
      console.error('Post site not found for id', postSiteId);
      return process.exit(1);
    }

    const tenantId = post.tenantId || post.tenant_id || null;
    console.log('Found post site. tenantId=', tenantId);

    // Create a siteTour for this post site
    const tour = await db.siteTour.create({
      id: uuidv4(),
      name: 'Seed Tour for Frontend Debug',
      description: 'Auto-created tour for TagScans preview',
      postSiteId: postSiteId,
      tenantId: tenantId,
      active: true,
    });

    console.log('Created siteTour', tour.id);

    // Create a tag for the tour
    const tag1 = await db.siteTourTag.create({
      id: uuidv4(),
      name: 'Seed Tag 1',
      tagType: 'qr',
      tagIdentifier: `SEED-TAG-1-${Date.now()}`,
      postSiteId: postSiteId,
      tenantId: tenantId,
      siteTourId: tour.id,
    });

    const tag2 = await db.siteTourTag.create({
      id: uuidv4(),
      name: 'Seed Tag 2',
      tagType: 'qr',
      tagIdentifier: `SEED-TAG-2-${Date.now()}`,
      postSiteId: postSiteId,
      tenantId: tenantId,
      siteTourId: tour.id,
    });

    console.log('Created tags', tag1.id, tag2.id);

    // Insert two tagScan rows for those tags
    const scan1 = await db.tagScan.create({
      id: uuidv4(),
      siteTourTagId: tag1.id,
      tourAssignmentId: null,
      securityGuardId: null,
      stationId: null,
      scannedAt: new Date(),
      scannedData: { latitude: -2.17, longitude: -79.92, note: 'Seed scan 1' },
    });

    const scan2 = await db.tagScan.create({
      id: uuidv4(),
      siteTourTagId: tag2.id,
      tourAssignmentId: null,
      securityGuardId: null,
      stationId: null,
      scannedAt: new Date(),
      scannedData: { latitude: -2.18, longitude: -79.91, note: 'Seed scan 2' },
    });

    console.log('Inserted tagScans:', scan1.id, scan2.id);
    console.log('Done. You can now refresh the frontend TagScans view.');
  } catch (err: any) {
    console.error('Error inserting seed scans:', err && err.message ? err.message : err);
    process.exitCode = 1;
  } finally {
    try { await db.sequelize.close(); } catch (e) {}
  }
})();
