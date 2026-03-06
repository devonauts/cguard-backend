import PermissionChecker from '../services/user/permissionChecker';
import ApiResponseHandler from './apiResponseHandler';
import SiteTourService from '../services/siteTourService';
import Permissions from '../security/permissions';
import Error400 from '../errors/Error400';

export default function (router) {
  // GET list /api/tenant/:tenantId/site-tour
  router.get('/tenant/:tenantId/site-tour', async (req, res, next) => {
    try {
      console.log('[DEBUG] GET /site-tour - tenantId:', req.params.tenantId);
      console.log('[DEBUG] currentTenant:', req.currentTenant ? req.currentTenant.id : 'MISSING');
      console.log('[DEBUG] Query params:', req.query);
      
      new PermissionChecker(req).validateHas(Permissions.values.postSiteRead);
      console.log('[DEBUG] Permission check passed');
      
      const where: any = { tenantId: req.currentTenant.id };
      // allow optional filtering by postSiteId
      if (req.query && req.query.postSiteId) {
        where.postSiteId = req.query.postSiteId;
      }
      console.log('[DEBUG] Query WHERE:', where);
      
      const rows = await req.database.siteTour.findAll({ where });
      console.log('[DEBUG] Found rows:', rows.length);
      
      await ApiResponseHandler.success(req, res, { rows, count: rows.length });
    } catch (error) {
      console.error('[DEBUG] Error in GET /site-tour:', error);
      await ApiResponseHandler.error(req, res, error);
    }
  });

  // GET /api/tenant/:tenantId/site-tour/:id
  router.get('/tenant/:tenantId/site-tour/:id', async (req, res, next) => {
    try {
      new PermissionChecker(req).validateHas(Permissions.values.postSiteRead);
      const payload = await new SiteTourService(req).findById(req.params.id);
      await ApiResponseHandler.success(req, res, payload);
    } catch (error) {
      await ApiResponseHandler.error(req, res, error);
    }
  });

  // POST /api/tenant/:tenantId/site-tour
  router.post('/tenant/:tenantId/site-tour', async (req, res, next) => {
    try {
      new PermissionChecker(req).validateHas(Permissions.values.postSiteCreate);
      const tenant = req.currentTenant;
      const currentUser = (req as any).currentUser;

      const payload = {
        name: req.body.name,
        description: req.body.description,
        scheduledDays: req.body.scheduledDays,
        postSiteId: req.body.postSiteId || null,
        securityGuardId: req.body.securityGuardId || null,
        continuous: req.body.continuous,
        timeMode: req.body.timeMode,
        selectTime: req.body.selectTime,
        maxDuration: req.body.maxDuration,
        active: typeof req.body.active !== 'undefined' ? req.body.active : true,
        tenantId: tenant && tenant.id,
        createdById: currentUser && currentUser.id,
        updatedById: currentUser && currentUser.id,
      };

      const record = await req.database.siteTour.create(payload);
      // If caller provided a guard id, create an initial assignment
      try {
        const guardId = req.body.securityGuardId || req.body.guardId || null;
        if (guardId) {
          const assignmentPayload: any = {
            siteTourId: record.id,
            securityGuardId: guardId,
            postSiteId: payload.postSiteId || null,
            tenantId: tenant && tenant.id,
            createdById: currentUser && currentUser.id,
            updatedById: currentUser && currentUser.id,
          };
          // create assignment if model exists
          if (req.database.tourAssignment) {
            await req.database.tourAssignment.create(assignmentPayload);
          }
        }
      } catch (e) {
        // don't fail the creation if assignment fails; log for debugging
        console.warn('Failed to create initial tour assignment', e);
      }
      await ApiResponseHandler.success(req, res, record);
    } catch (error) {
      await ApiResponseHandler.error(req, res, error);
    }
  });

  // PUT/PATCH /api/tenant/:tenantId/site-tour/:id
  router.put('/tenant/:tenantId/site-tour/:id', async (req, res, next) => {
    try {
      new PermissionChecker(req).validateHas(Permissions.values.postSiteEdit);
      const currentUser = (req as any).currentUser;
      const record = await req.database.siteTour.findOne({ where: { id: req.params.id, tenantId: req.currentTenant.id } });
      if (!record) throw new Error('Not found');
      const updateData = {
        name: req.body.name,
        description: req.body.description,
        scheduledDays: req.body.scheduledDays,
        continuous: req.body.continuous,
        timeMode: req.body.timeMode,
        selectTime: req.body.selectTime,
        maxDuration: req.body.maxDuration,
        active: typeof req.body.active !== 'undefined' ? req.body.active : record.active,
        updatedById: currentUser && currentUser.id,
      };
      await record.update(updateData);
      await ApiResponseHandler.success(req, res, record);
    } catch (error) {
      await ApiResponseHandler.error(req, res, error);
    }
  });

  router.patch('/tenant/:tenantId/site-tour/:id', async (req, res, next) => {
    try {
      new PermissionChecker(req).validateHas(Permissions.values.postSiteEdit);
      const currentUser = (req as any).currentUser;
      const record = await req.database.siteTour.findOne({ where: { id: req.params.id, tenantId: req.currentTenant.id } });
      if (!record) throw new Error('Not found');
      const updateData: any = { updatedById: currentUser && currentUser.id };
      Object.assign(updateData, req.body);
      await record.update(updateData);
      await ApiResponseHandler.success(req, res, record);
    } catch (error) {
      await ApiResponseHandler.error(req, res, error);
    }
  });

  // DELETE /api/tenant/:tenantId/site-tour/:id
  router.delete('/tenant/:tenantId/site-tour/:id', async (req, res, next) => {
    try {
      new PermissionChecker(req).validateHas(Permissions.values.postSiteDestroy || Permissions.values.postSiteEdit);
      const record = await req.database.siteTour.findOne({ where: { id: req.params.id, tenantId: req.currentTenant.id } });
      if (!record) throw new Error('Not found');
      await record.destroy();
      await ApiResponseHandler.success(req, res, {});
    } catch (error) {
      await ApiResponseHandler.error(req, res, error);
    }
  });

  // ----- SiteTourTag CRUD -----
  // POST create tag: /tenant/:tenantId/site-tour/:tourId/tag
  router.post('/tenant/:tenantId/site-tour/:tourId/tag', async (req, res, next) => {
    try {
      new PermissionChecker(req).validateHas(Permissions.values.postSiteEdit);
      const tenant = req.currentTenant;
      const currentUser = (req as any).currentUser;
      const tourId = req.params.tourId;

      // ensure tour exists
      const tour = await req.database.siteTour.findOne({ where: { id: tourId, tenantId: tenant.id } });
      if (!tour) {
        const err: any = new Error('Tour not found'); err.code = 404; throw err;
      }

      const tagIdentifier = req.body.tagIdentifier || req.body.tagId || String(Date.now());
      // uniqueness check for identifier within tenant
      const existing = await req.database.siteTourTag.findOne({ where: { tagIdentifier, tenantId: tenant.id } });
      if (existing) {
        const err = new Error400(req.language, 'entities.siteTourTag.errors.exists');
        (err as any).errors = { tagIdentifier };
        throw err;
      }

      const payload = {
        name: req.body.name,
        tagType: req.body.tagType,
        tagIdentifier,
        location: req.body.location,
        instructions: req.body.instructions,
        latitude: req.body.latitude,
        longitude: req.body.longitude,
        showGeoFence: req.body.showGeoFence,
        siteTourId: tourId,
        tenantId: tenant.id,
        createdById: currentUser && currentUser.id,
        updatedById: currentUser && currentUser.id,
      };

      const tag = await req.database.siteTourTag.create(payload);
      await ApiResponseHandler.success(req, res, tag);
    } catch (error) {
      await ApiResponseHandler.error(req, res, error);
    }
  });

  // GET tags for tour: /tenant/:tenantId/site-tour/:tourId/tags
  router.get('/tenant/:tenantId/site-tour/:tourId/tags', async (req, res, next) => {
    try {
      new PermissionChecker(req).validateHas(Permissions.values.postSiteRead);
      const tourId = req.params.tourId;
      const where: any = { siteTourId: tourId, tenantId: req.currentTenant.id };
      // optional filter by tagType (e.g., qr, nfc, virtual, ble)
      if (req.query && req.query.tagType) {
        where.tagType = req.query.tagType;
      }
      let rows = await req.database.siteTourTag.findAll({ where });

      // If no rows were found, attempt a diagnostic fallback: try without tenantId
      // (helps detect missing tenantId on existing data). Return a hint flag when fallback used.
      let fallbackUsed = false;
      if ((!rows || rows.length === 0) && where.tenantId) {
        try {
          // eslint-disable-next-line no-console
          console.warn(`site-tour tags: no rows for tenant ${where.tenantId}, trying fallback without tenant filter for tour ${tourId}`);
          const altWhere: any = { siteTourId: tourId };
          if (req.query && req.query.tagType) altWhere.tagType = req.query.tagType;
          const altRows = await req.database.siteTourTag.findAll({ where: altWhere });
          if (altRows && altRows.length > 0) {
            rows = altRows;
            fallbackUsed = true;
          }
        } catch (e) {
          // swallow fallback errors and continue returning empty
          // eslint-disable-next-line no-console
          console.error('Fallback site-tour tags query failed', e);
        }
      }

      // Normalize rows to plain objects to avoid Sequelize instances on the wire
      const plain = (rows || []).map(r => (typeof r.get === 'function' ? r.get({ plain: true }) : r));
      await ApiResponseHandler.success(req, res, { rows: plain, count: plain.length, fallbackTenantMismatch: fallbackUsed });
    } catch (error) {
      await ApiResponseHandler.error(req, res, error);
    }
  });

  // GET tags for a post site (all tours under this site)
  // /tenant/:tenantId/post-site/:postSiteId/site-tour-tags
  router.get('/tenant/:tenantId/post-site/:postSiteId/site-tour-tags', async (req, res, next) => {
    try {
      new PermissionChecker(req).validateHas(Permissions.values.postSiteRead);
      const postSiteId = req.params.postSiteId;
      const tenantId = req.currentTenant.id;

      // find tours for this post site belonging to tenant
      const tours = await req.database.siteTour.findAll({ where: { postSiteId, tenantId }, attributes: ['id'] });
      const tourIds = (tours || []).map((t: any) => t.id).filter(Boolean);

      if (!tourIds.length) {
        // no tours -> return empty
        await ApiResponseHandler.success(req, res, { rows: [], count: 0 });
        return;
      }

      const where: any = { siteTourId: tourIds };
      if (req.query && req.query.tagType) {
        where.tagType = req.query.tagType;
      }

      let rows = await req.database.siteTourTag.findAll({ where });

      // fallback diagnostic: try without tenant filtering on tags if none found
      let fallbackUsed = false;
      if ((!rows || rows.length === 0) && tourIds.length) {
        try {
          const altWhere: any = { siteTourId: tourIds };
          if (req.query && req.query.tagType) altWhere.tagType = req.query.tagType;
          const altRows = await req.database.siteTourTag.findAll({ where: altWhere });
          if (altRows && altRows.length > 0) {
            rows = altRows;
            fallbackUsed = true;
          }
        } catch (e) {
          // ignore
        }
      }

      const plain = (rows || []).map((r: any) => (typeof r.get === 'function' ? r.get({ plain: true }) : r));
      await ApiResponseHandler.success(req, res, { rows: plain, count: plain.length, fallbackTenantMismatch: fallbackUsed });
    } catch (error) {
      await ApiResponseHandler.error(req, res, error);
    }
  });

  // GET single tag: /tenant/:tenantId/site-tour/:tourId/tag/:tagId
  router.get('/tenant/:tenantId/site-tour/:tourId/tag/:tagId', async (req, res, next) => {
    try {
      new PermissionChecker(req).validateHas(Permissions.values.postSiteRead);
      const tag = await req.database.siteTourTag.findOne({ where: { id: req.params.tagId, siteTourId: req.params.tourId, tenantId: req.currentTenant.id } });
      if (!tag) {
        const err: any = new Error('Not found'); err.code = 404; throw err;
      }
      await ApiResponseHandler.success(req, res, tag);
    } catch (error) {
      await ApiResponseHandler.error(req, res, error);
    }
  });

  // PUT/PATCH update tag
  router.put('/tenant/:tenantId/site-tour/:tourId/tag/:tagId', async (req, res, next) => {
    try {
      new PermissionChecker(req).validateHas(Permissions.values.postSiteEdit);
      const tag = await req.database.siteTourTag.findOne({ where: { id: req.params.tagId, siteTourId: req.params.tourId, tenantId: req.currentTenant.id } });
      if (!tag) throw new Error('Not found');
      const updateData: any = {};
      Object.assign(updateData, req.body);
      await tag.update(updateData);
      await ApiResponseHandler.success(req, res, tag);
    } catch (error) {
      await ApiResponseHandler.error(req, res, error);
    }
  });

  router.patch('/tenant/:tenantId/site-tour/:tourId/tag/:tagId', async (req, res, next) => {
    try {
      new PermissionChecker(req).validateHas(Permissions.values.postSiteEdit);
      const tag = await req.database.siteTourTag.findOne({ where: { id: req.params.tagId, siteTourId: req.params.tourId, tenantId: req.currentTenant.id } });
      if (!tag) throw new Error('Not found');
      await tag.update(req.body);
      await ApiResponseHandler.success(req, res, tag);
    } catch (error) {
      await ApiResponseHandler.error(req, res, error);
    }
  });

  // DELETE tag
  router.delete('/tenant/:tenantId/site-tour/:tourId/tag/:tagId', async (req, res, next) => {
    try {
      new PermissionChecker(req).validateHas(Permissions.values.postSiteDestroy || Permissions.values.postSiteEdit);
      const tag = await req.database.siteTourTag.findOne({ where: { id: req.params.tagId, siteTourId: req.params.tourId, tenantId: req.currentTenant.id } });
      if (!tag) throw new Error('Not found');
      await tag.destroy();
      await ApiResponseHandler.success(req, res, {});
    } catch (error) {
      await ApiResponseHandler.error(req, res, error);
    }
  });

  // POST /api/tenant/:tenantId/site-tour/:id/assign
  router.post('/tenant/:tenantId/site-tour/:id/assign', async (req, res, next) => {
    try {
      new PermissionChecker(req).validateHas(Permissions.values.postSiteEdit);
      const service = new SiteTourService(req);
      const guardId = req.body.securityGuardId;
      const payload = await service.assignGuard(req.params.id, guardId, req.body || {});
      await ApiResponseHandler.success(req, res, payload);
    } catch (error) {
      await ApiResponseHandler.error(req, res, error);
    }
  });

  // POST /api/tenant/:tenantId/site-tour/tag-scan
  router.post('/tenant/:tenantId/site-tour/tag-scan', async (req, res, next) => {
    try {
      // Allow guards to report scans (they must be authenticated)
      const service = new SiteTourService(req);
      const { tagIdentifier, latitude, longitude, scannedData } = req.body;
      const securityGuardId = req.body.securityGuardId || (req as any).currentUser && (req as any).currentUser.id;
      const payload = await service.recordTagScan({ tagIdentifier, securityGuardId, latitude, longitude, scannedData });
      await ApiResponseHandler.success(req, res, payload);
    } catch (error) {
      await ApiResponseHandler.error(req, res, error);
    }
  });

  // DEBUG: Return all siteTourTag rows (development only)
  router.get('/debug/site-tour-tags', async (req, res, next) => {
    try {
      if (process.env.NODE_ENV === 'production') {
        const err: any = new Error('Not allowed'); err.code = 403; throw err;
      }
      const rows = await req.database.siteTourTag.findAll({ include: [{ model: req.database.siteTour, as: 'siteTour' }], limit: 2000 });
      const plain = (rows || []).map((r: any) => (typeof r.get === 'function' ? r.get({ plain: true }) : r));
      await ApiResponseHandler.success(req, res, { rows: plain, count: plain.length });
    } catch (error) {
      await ApiResponseHandler.error(req, res, error);
    }
  });

  // DEBUG (no auth): Return tags for a tenant + postSiteId (development only)
  router.get('/debug/tenant/:tenantId/post-site/:postSiteId/site-tour-tags', async (req, res, next) => {
    try {
      if (process.env.NODE_ENV === 'production') {
        const err: any = new Error('Not allowed'); err.code = 403; throw err;
      }
      const tenantId = req.params.tenantId;
      const postSiteId = req.params.postSiteId;

      // find tours for this post site
      const tours = await req.database.siteTour.findAll({ where: { postSiteId }, attributes: ['id', 'tenantId', 'postSiteId'] });
      const tourIds = (tours || []).map((t: any) => t.id).filter(Boolean);

      if (!tourIds.length) {
        await ApiResponseHandler.success(req, res, { rows: [], count: 0 });
        return;
      }

      const where: any = { siteTourId: tourIds };
      if (req.query && req.query.tagType) where.tagType = req.query.tagType;

      // Also attempt to ensure tenantId matches if provided
      if (tenantId) where.tenantId = tenantId;

      const rows = await req.database.siteTourTag.findAll({ where, include: [{ model: req.database.siteTour, as: 'siteTour' }], limit: 2000 });
      const plain = (rows || []).map((r: any) => (typeof r.get === 'function' ? r.get({ plain: true }) : r));
      await ApiResponseHandler.success(req, res, { rows: plain, count: plain.length });
    } catch (error) {
      await ApiResponseHandler.error(req, res, error);
    }
  });
}
