import PermissionChecker from '../services/user/permissionChecker';
import ApiResponseHandler from './apiResponseHandler';
import SiteTourService from '../services/siteTourService';
import Permissions from '../security/permissions';
import Error400 from '../errors/Error400';
import { Op } from 'sequelize';

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
      // Rondas are isolated per station / per post-site. Honor both filters so a
      // station never sees another station's (or another client's) rondas.
      if (req.query && req.query.stationId) {
        where.stationId = req.query.stationId;
      }
      if (req.query && req.query.postSiteId) {
        where.postSiteId = req.query.postSiteId;
      }

      const rows = await req.database.siteTour.findAll({ where });
      console.log('[DEBUG] Found rows:', rows.length);
      const plain = (rows || []).map((r: any) => (typeof r.get === 'function' ? r.get({ plain: true }) : r));
      // Ensure we surface the core fields expected by the frontend
      const fields = ['id','name','description','scheduledDays','continuous','timeMode','selectTime','maxDuration','active','importHash','createdAt','updatedAt','deletedAt','postSiteId','stationId','tenantId','createdById','updatedById','securityGuardId'];
      const filtered = plain.map((p: any) => {
        const out: any = {};
        fields.forEach(f => { out[f] = typeof p[f] !== 'undefined' ? p[f] : null; });
        return out;
      });

      await ApiResponseHandler.success(req, res, { rows: filtered, count: filtered.length });
    } catch (error: any) {
      console.error('[DEBUG] Error in GET /site-tour:', error);
      await ApiResponseHandler.error(req, res, error);
    }
  });

  // GET /api/tenant/:tenantId/site-tour/:id
  router.get('/tenant/:tenantId/site-tour/:id', async (req, res, next) => {
    try {
      new PermissionChecker(req).validateHas(Permissions.values.postSiteRead);
      const payload = await new SiteTourService(req).findById(req.params.id);
      const plain = (payload && typeof payload.get === 'function') ? payload.get({ plain: true }) : payload;
      const fields = ['id','name','description','scheduledDays','continuous','timeMode','selectTime','maxDuration','active','importHash','createdAt','updatedAt','deletedAt','postSiteId','stationId','tenantId','createdById','updatedById','securityGuardId'];
      const out: any = {};
      fields.forEach(f => { out[f] = typeof plain[f] !== 'undefined' ? plain[f] : null; });
      // also include tags if present
      if (plain.tags) out.tags = plain.tags;
      await ApiResponseHandler.success(req, res, out);
    } catch (error: any) {
      await ApiResponseHandler.error(req, res, error);
    }
  });

  // POST /api/tenant/:tenantId/site-tour
  router.post('/tenant/:tenantId/site-tour', async (req, res, next) => {
    try {
      new PermissionChecker(req).validateHas(Permissions.values.postSiteCreate);
      const tenant = req.currentTenant;
      const currentUser = (req as any).currentUser;

      // stationId is required to create a site tour
      if (!req.body || !req.body.stationId) {
        const err = new Error400(req.language, 'entities.siteTour.errors.stationRequired');
        (err as any).errors = { stationId: 'Station id is required' };
        throw err;
      }

      const payload = {
        name: req.body.name,
        description: req.body.description,
        scheduledDays: req.body.scheduledDays,
        postSiteId: req.body.postSiteId || null,
        stationId: req.body.stationId || null,
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
            stationId: payload.stationId || null,
            tenantId: tenant && tenant.id,
            createdById: currentUser && currentUser.id,
            updatedById: currentUser && currentUser.id,
          };
          // create assignment if model exists
          if (req.database.tourAssignment) {
            await req.database.tourAssignment.create(assignmentPayload);
          }
        }
      } catch (e: any) {
        // don't fail the creation if assignment fails; log for debugging
        console.warn('Failed to create initial tour assignment', e);
      }
      await ApiResponseHandler.success(req, res, record);
    } catch (error: any) {
      await ApiResponseHandler.error(req, res, error);
    }
  });

  // PUT/PATCH /api/tenant/:tenantId/site-tour/:id
  router.put('/tenant/:tenantId/site-tour/:id', async (req, res, next) => {
    try {
      new PermissionChecker(req).validateHas(Permissions.values.postSiteEdit);
      const currentUser = (req as any).currentUser;
      const record = await req.database.siteTour.findOne({ where: { id: req.params.id, tenantId: req.currentTenant.id } });
      if (!record) throw Object.assign(new Error('Not found'), { code: 404 });
      const updateData = {
        name: req.body.name,
        description: req.body.description,
        scheduledDays: req.body.scheduledDays,
        stationId: req.body.stationId,
        continuous: req.body.continuous,
        timeMode: req.body.timeMode,
        selectTime: req.body.selectTime,
        maxDuration: req.body.maxDuration,
        active: typeof req.body.active !== 'undefined' ? req.body.active : record.active,
        updatedById: currentUser && currentUser.id,
      };
      await record.update(updateData);
      await ApiResponseHandler.success(req, res, record);
    } catch (error: any) {
      await ApiResponseHandler.error(req, res, error);
    }
  });

  router.patch('/tenant/:tenantId/site-tour/:id', async (req, res, next) => {
    try {
      new PermissionChecker(req).validateHas(Permissions.values.postSiteEdit);
      const currentUser = (req as any).currentUser;
      const record = await req.database.siteTour.findOne({ where: { id: req.params.id, tenantId: req.currentTenant.id } });
      if (!record) throw Object.assign(new Error('Not found'), { code: 404 });
      // Whitelist editable columns — never let the body set tenantId/createdById/
      // id (mass-assignment let a client re-parent a ronda to another tenant/client).
      const SITE_TOUR_EDITABLE = ['name', 'description', 'scheduledDays', 'postSiteId', 'stationId', 'securityGuardId', 'continuous', 'timeMode', 'selectTime', 'maxDuration', 'active'];
      const updateData: any = { updatedById: currentUser && currentUser.id };
      for (const k of SITE_TOUR_EDITABLE) {
        if (Object.prototype.hasOwnProperty.call(req.body || {}, k)) updateData[k] = req.body[k];
      }
      await record.update(updateData);
      await ApiResponseHandler.success(req, res, record);
    } catch (error: any) {
      await ApiResponseHandler.error(req, res, error);
    }
  });

  // DELETE /api/tenant/:tenantId/site-tour/:id
  router.delete('/tenant/:tenantId/site-tour/:id', async (req, res, next) => {
    try {
      new PermissionChecker(req).validateHas(Permissions.values.postSiteDestroy || Permissions.values.postSiteEdit);
      const record = await req.database.siteTour.findOne({ where: { id: req.params.id, tenantId: req.currentTenant.id } });
      if (!record) throw Object.assign(new Error('Not found'), { code: 404 });
      await record.destroy();
      await ApiResponseHandler.success(req, res, {});
    } catch (error: any) {
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
        geofenceRadius:
          req.body.geofenceRadius != null && !isNaN(Number(req.body.geofenceRadius))
            ? Number(req.body.geofenceRadius)
            : null,
        siteTourId: tourId,
        postSiteId: tour.postSiteId || null,
        // Assign the QR/checkpoint to a station (explicit, or inherit the tour's).
        stationId: req.body.stationId || tour.stationId || null,
        tenantId: tenant.id,
        createdById: currentUser && currentUser.id,
        updatedById: currentUser && currentUser.id,
      };

      const tag = await req.database.siteTourTag.create(payload);
      await ApiResponseHandler.success(req, res, tag);
    } catch (error: any) {
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
      // SECURITY: scoped strictly to this tenant's tour. No "fallback without
      // tenant filter" — that would return another tenant's checkpoints by tourId.
      const rows = await req.database.siteTourTag.findAll({ where });

      // Normalize rows to plain objects to avoid Sequelize instances on the wire
      const plain = (rows || []).map(r => (typeof r.get === 'function' ? r.get({ plain: true }) : r));
      await ApiResponseHandler.success(req, res, { rows: plain, count: plain.length });
    } catch (error: any) {
      await ApiResponseHandler.error(req, res, error);
    }
  });

  // GET full ronda (patrol round) detail: /tenant/:tenantId/site-tour/ronda/:assignmentId
  // Checkpoints (scanned + missed) with scan time / photo / note / geo verdict.
  router.get('/tenant/:tenantId/site-tour/ronda/:assignmentId', async (req, res, next) => {
    try {
      new PermissionChecker(req).validateHas(Permissions.values.postSiteRead);
      const { buildRondaDetail } = require('../services/rondaDetailService');
      const detail = await buildRondaDetail(req.database, req.currentTenant.id, req.params.assignmentId);
      if (!detail) { const e: any = new Error('Not found'); e.code = 404; throw e; }
      await ApiResponseHandler.success(req, res, detail);
    } catch (error: any) {
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

      const where: any = { tenantId };
      if (req.query && req.query.tagType) {
        where.tagType = req.query.tagType;
      }

      // Match tags that either belong to the tours under this postSite OR have postSiteId set
      where[Op.or] = [{ siteTourId: tourIds }];
      if (postSiteId) where[Op.or].push({ postSiteId });

      // SECURITY: strictly tenant-scoped (where includes tenantId). No fallback
      // that drops the tenant filter.
      const rows = await req.database.siteTourTag.findAll({ where });

      const plain = (rows || []).map((r: any) => (typeof r.get === 'function' ? r.get({ plain: true }) : r));
      await ApiResponseHandler.success(req, res, { rows: plain, count: plain.length });
    } catch (error: any) {
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
    } catch (error: any) {
      await ApiResponseHandler.error(req, res, error);
    }
  });

  // PUT/PATCH update tag
  router.put('/tenant/:tenantId/site-tour/:tourId/tag/:tagId', async (req, res, next) => {
    try {
      new PermissionChecker(req).validateHas(Permissions.values.postSiteEdit);
      const tag = await req.database.siteTourTag.findOne({ where: { id: req.params.tagId, siteTourId: req.params.tourId, tenantId: req.currentTenant.id } });
      if (!tag) throw Object.assign(new Error('Not found'), { code: 404 });
      // Whitelist editable columns — never let the body set tenantId/id.
      const TAG_EDITABLE = ['name', 'tagType', 'tagIdentifier', 'location', 'instructions', 'latitude', 'longitude', 'showGeoFence', 'geofenceRadius', 'postSiteId', 'stationId'];
      const updateData: any = {};
      for (const k of TAG_EDITABLE) {
        if (Object.prototype.hasOwnProperty.call(req.body || {}, k)) updateData[k] = req.body[k];
      }
      await tag.update(updateData);
      await ApiResponseHandler.success(req, res, tag);
    } catch (error: any) {
      await ApiResponseHandler.error(req, res, error);
    }
  });

  router.patch('/tenant/:tenantId/site-tour/:tourId/tag/:tagId', async (req, res, next) => {
    try {
      new PermissionChecker(req).validateHas(Permissions.values.postSiteEdit);
      const tag = await req.database.siteTourTag.findOne({ where: { id: req.params.tagId, siteTourId: req.params.tourId, tenantId: req.currentTenant.id } });
      if (!tag) throw Object.assign(new Error('Not found'), { code: 404 });
      // Whitelist editable columns — never let the body set tenantId/id.
      const TAG_EDITABLE = ['name', 'tagType', 'tagIdentifier', 'location', 'instructions', 'latitude', 'longitude', 'showGeoFence', 'geofenceRadius', 'postSiteId', 'stationId'];
      const updateData: any = {};
      for (const k of TAG_EDITABLE) {
        if (Object.prototype.hasOwnProperty.call(req.body || {}, k)) updateData[k] = req.body[k];
      }
      await tag.update(updateData);
      await ApiResponseHandler.success(req, res, tag);
    } catch (error: any) {
      await ApiResponseHandler.error(req, res, error);
    }
  });

  // DELETE tag
  router.delete('/tenant/:tenantId/site-tour/:tourId/tag/:tagId', async (req, res, next) => {
    try {
      new PermissionChecker(req).validateHas(Permissions.values.postSiteDestroy || Permissions.values.postSiteEdit);
      const tag = await req.database.siteTourTag.findOne({ where: { id: req.params.tagId, siteTourId: req.params.tourId, tenantId: req.currentTenant.id } });
      if (!tag) throw Object.assign(new Error('Not found'), { code: 404 });
      await tag.destroy();
      await ApiResponseHandler.success(req, res, {});
    } catch (error: any) {
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
    } catch (error: any) {
      await ApiResponseHandler.error(req, res, error);
    }
  });

  // GET assignments for a tour: /tenant/:tenantId/site-tour/:tourId/assignments
  router.get('/tenant/:tenantId/site-tour/:tourId/assignments', async (req, res, next) => {
    try {
      new PermissionChecker(req).validateHas(Permissions.values.postSiteRead);
      // ensure tour exists and belongs to tenant
      const tourId = req.params.tourId;
      const tour = await req.database.siteTour.findOne({ where: { id: tourId, tenantId: req.currentTenant.id } });
      if (!tour) {
        const err: any = new Error('Tour not found'); err.code = 404; throw err;
      }
      const service = new SiteTourService(req);
      const rows = await service.listAssignments(tourId);
      await ApiResponseHandler.success(req, res, { rows: rows || [], count: (rows || []).length });
    } catch (error: any) {
      await ApiResponseHandler.error(req, res, error);
    }
  });

  // GET ronda session history for a station (admin "Historial de Rondas").
  // /tenant/:tenantId/station/:stationId/ronda-history
  router.get('/tenant/:tenantId/station/:stationId/ronda-history', async (req, res, next) => {
    try {
      new PermissionChecker(req).validateHas(Permissions.values.postSiteRead);
      const db = req.database;
      const tenantId = req.currentTenant.id;
      const stationId = req.params.stationId;
      const limit = Math.min(Number(req.query.limit) || 50, 200);
      const offset = Number(req.query.offset) || 0;

      const count = await db.tourAssignment.count({ where: { tenantId, stationId } });
      const rows = await db.tourAssignment.findAll({
        where: { tenantId, stationId },
        include: [
          { model: db.siteTour, as: 'siteTour', attributes: ['id', 'name'], required: false },
          { model: db.securityGuard, as: 'guard', attributes: ['id', 'fullName'], required: false },
          { model: db.tagScan, as: 'scans', attributes: ['id', 'siteTourTagId', 'scannedAt', 'validLocation', 'distanceMeters'], required: false },
        ],
        order: [['startAt', 'DESC'], ['createdAt', 'DESC']],
        limit,
        offset,
      });

      // Total checkpoints per tour (for progress) + checkpoint names (for scans).
      const tourIds = Array.from(new Set((rows || []).map((r: any) => r.siteTourId).filter(Boolean)));
      const tagCountByTour: Record<string, number> = {};
      if (tourIds.length) {
        const counts = await db.siteTourTag.findAll({
          where: { siteTourId: tourIds },
          attributes: ['siteTourId', [db.Sequelize.fn('COUNT', db.Sequelize.col('id')), 'cnt']],
          group: ['siteTourId'],
          raw: true,
        });
        counts.forEach((c: any) => { tagCountByTour[c.siteTourId] = Number(c.cnt); });
      }
      const tagIds = Array.from(new Set((rows || []).flatMap((r: any) => (r.scans || []).map((s: any) => s.siteTourTagId)).filter(Boolean)));
      const tagNameById: Record<string, string> = {};
      if (tagIds.length) {
        const tags = await db.siteTourTag.findAll({ where: { id: tagIds }, attributes: ['id', 'name'], raw: true });
        tags.forEach((t: any) => { tagNameById[t.id] = t.name; });
      }

      const out = (rows || []).map((r: any) => {
        const p = r.get ? r.get({ plain: true }) : r;
        const scans = (p.scans || [])
          .map((s: any) => ({
            id: s.id,
            checkpoint: tagNameById[s.siteTourTagId] || '—',
            scannedAt: s.scannedAt,
            validLocation: s.validLocation,
            distanceMeters: s.distanceMeters,
          }))
          .sort((a: any, b: any) => new Date(a.scannedAt).getTime() - new Date(b.scannedAt).getTime());
        return {
          id: p.id,
          rondaName: (p.siteTour && p.siteTour.name) || 'Ronda',
          guardName: (p.guard && p.guard.fullName) || '—',
          startAt: p.startAt,
          endAt: p.endAt,
          status: p.status,
          totalTags: tagCountByTour[p.siteTourId] || 0,
          scannedCount: scans.length,
          validCount: scans.filter((s: any) => s.validLocation === true).length,
          outCount: scans.filter((s: any) => s.validLocation === false).length,
          scans,
        };
      });

      await ApiResponseHandler.success(req, res, { rows: out, count });
    } catch (error: any) {
      await ApiResponseHandler.error(req, res, error);
    }
  });

  // GET single assignment: /tenant/:tenantId/site-tour/:tourId/assign/:assignmentId
  router.get('/tenant/:tenantId/site-tour/:tourId/assign/:assignmentId', async (req, res, next) => {
    try {
      new PermissionChecker(req).validateHas(Permissions.values.postSiteRead);
      const tourId = req.params.tourId;
      const tour = await req.database.siteTour.findOne({ where: { id: tourId, tenantId: req.currentTenant.id } });
      if (!tour) {
        const err: any = new Error('Tour not found'); err.code = 404; throw err;
      }
      const service = new SiteTourService(req);
      const assignment = await service.getAssignment(req.params.assignmentId);
      if (!assignment || String(assignment.siteTourId) !== String(tourId)) {
        const err: any = new Error('Not found'); err.code = 404; throw err;
      }
      await ApiResponseHandler.success(req, res, assignment);
    } catch (error: any) {
      await ApiResponseHandler.error(req, res, error);
    }
  });

  // PATCH update assignment: /tenant/:tenantId/site-tour/:tourId/assign/:assignmentId
  router.patch('/tenant/:tenantId/site-tour/:tourId/assign/:assignmentId', async (req, res, next) => {
    try {
      new PermissionChecker(req).validateHas(Permissions.values.postSiteEdit);
      const tourId = req.params.tourId;
      const tour = await req.database.siteTour.findOne({ where: { id: tourId, tenantId: req.currentTenant.id } });
      if (!tour) {
        const err: any = new Error('Tour not found'); err.code = 404; throw err;
      }
      const service = new SiteTourService(req);
      const payload = await service.updateAssignment(req.params.assignmentId, req.body || {});
      if (!payload || String(payload.siteTourId) !== String(tourId)) {
        const err: any = new Error('Not found'); err.code = 404; throw err;
      }
      await ApiResponseHandler.success(req, res, payload);
    } catch (error: any) {
      await ApiResponseHandler.error(req, res, error);
    }
  });

  // DELETE (soft) assignment: /tenant/:tenantId/site-tour/:tourId/assign/:assignmentId
  router.delete('/tenant/:tenantId/site-tour/:tourId/assign/:assignmentId', async (req, res, next) => {
    try {
      new PermissionChecker(req).validateHas(Permissions.values.postSiteDestroy || Permissions.values.postSiteEdit);
      const tourId = req.params.tourId;
      const tour = await req.database.siteTour.findOne({ where: { id: tourId, tenantId: req.currentTenant.id } });
      if (!tour) {
        const err: any = new Error('Tour not found'); err.code = 404; throw err;
      }
      const service = new SiteTourService(req);
      // ensure assignment belongs to tour inside service or enforce here
      const resPayload = await service.deleteAssignment(req.params.assignmentId);
      await ApiResponseHandler.success(req, res, resPayload || {});
    } catch (error: any) {
      await ApiResponseHandler.error(req, res, error);
    }
  });

  // POST /api/tenant/:tenantId/site-tour/tag-scan
  router.post('/tenant/:tenantId/site-tour/tag-scan', async (req, res, next) => {
    try {
      // Allow guards to report scans (they must be authenticated)
      const service = new SiteTourService(req);
      const { tagIdentifier, latitude, longitude, scannedData, stationId } = req.body;
      // Resolve the guard's securityGuard record id (the tagScans FK target).
      // The auth'd user id is NOT the securityGuard id, so look it up.
      let securityGuardId = req.body.securityGuardId || null;
      if (!securityGuardId && (req as any).currentUser) {
        const sg = await req.database.securityGuard.findOne({
          where: {
            guardId: (req as any).currentUser.id,
            tenantId: req.currentTenant && req.currentTenant.id,
            deletedAt: null,
          },
          attributes: ['id'],
        });
        securityGuardId = sg ? sg.id : null;
      }
      const payload = await service.recordTagScan({ tagIdentifier, securityGuardId, latitude, longitude, scannedData, stationId });
      await ApiResponseHandler.success(req, res, payload);
    } catch (error: any) {
      await ApiResponseHandler.error(req, res, error);
    }
  });

  // GET /api/tenant/:tenantId/site-tour/tag-scans
  router.get('/tenant/:tenantId/site-tour/tag-scans', async (req, res, next) => {
    try {
      // Debug: log incoming request context for tag-scans listing
      try {
        // eslint-disable-next-line no-console
        console.debug('[tag-scans] request params:', { params: req.params, query: req.query });
        // eslint-disable-next-line no-console
        console.debug('[tag-scans] currentTenant:', (req as any).currentTenant && (req as any).currentTenant.id ? (req as any).currentTenant.id : null, 'currentUser=', (req as any).currentUser && (req as any).currentUser.id ? (req as any).currentUser.id : null);
      } catch (e: any) {}
      new PermissionChecker(req).validateHas(Permissions.values.postSiteRead);
      const service = new SiteTourService(req);
      const filter: any = {};
      if (req.query.tourId) filter.tourId = req.query.tourId;
      if (req.query.postSiteId) filter.postSiteId = req.query.postSiteId;
      if (req.query.stationId) filter.stationId = req.query.stationId;
      if (req.query.assignmentId) filter.assignmentId = req.query.assignmentId;
      if (req.query.limit) filter.limit = req.query.limit;
      if (req.query.offset) filter.offset = req.query.offset;

      try {
        const rows = await service.listTagScans(filter);
        await ApiResponseHandler.success(req, res, { rows: rows || [], count: (rows || []).length });
      } catch (err) {
        // If running in development and the normal listing fails (e.g., missing columns
        // or tenant mismatches), attempt a safe debug SQL fallback to help developers.
        if (process.env.NODE_ENV !== 'production') {
          try {
            const tenantId = req.params.tenantId;
            const postSiteId = filter.postSiteId || req.query.postSiteId || null;
            if (postSiteId) {
              const debugSql = `
                SELECT
                  ts.*, t.tagIdentifier AS tagIdentifier, t.name AS tagName, st.id AS tourId,
                  s.id AS stationId, COALESCE(s.stationName, '') AS stationName,
                  COALESCE(g.fullName, g2.fullName, '') AS guardName, ta.id AS assignmentId
                FROM tagScans ts
                JOIN siteTourTags t ON ts.siteTourTagId = t.id
                JOIN siteTours st ON t.siteTourId = st.id
                LEFT JOIN stations s ON ts.stationId = s.id
                LEFT JOIN tourAssignments ta ON ts.tourAssignmentId = ta.id
                LEFT JOIN securityGuards g ON ts.securityGuardId = g.id
                LEFT JOIN securityGuards g2 ON ta.securityGuardId = g2.id
                WHERE st.postSiteId = :postSiteId AND (st.tenantId = :tenantId OR t.tenantId = :tenantId)
                ORDER BY ts.scannedAt DESC
                LIMIT 2000
              `;
              const replacements = { tenantId, postSiteId };
              const [debugRows]: any = await req.database.sequelize.query(debugSql, { replacements, type: req.database.sequelize.QueryTypes.SELECT });
              return await ApiResponseHandler.success(req, res, { rows: debugRows || [], count: (debugRows || []).length });
            }
          } catch (debugErr) {
            // fall through to returning original error
            console.error('[tag-scans] debug fallback failed', debugErr);
          }
        }
        throw err;
      }
    } catch (error: any) {
      try {
        // eslint-disable-next-line no-console
        console.error('[tag-scans] error while listing tag scans:', error && error.stack ? error.stack : error);
      } catch (e: any) {}
      await ApiResponseHandler.error(req, res, error);
    }
  });

  // GET /api/tenant/:tenantId/site-tour/tag-scans/export?format=pdf|excel
  router.get('/tenant/:tenantId/site-tour/tag-scans/export', async (req, res, next) => {
    try {
      new PermissionChecker(req).validateHas(Permissions.values.postSiteRead);
      const format = String(req.query.format || '').toLowerCase();
      if (!format || !['pdf', 'excel'].includes(format)) {
        return res.status(400).json({ message: 'Formato no soportado. Use "pdf" o "excel".' });
      }

      const service = new SiteTourService(req);
      const filter: any = {};
      if (req.query.tourId) filter.tourId = req.query.tourId;
      if (req.query.postSiteId) filter.postSiteId = req.query.postSiteId;
      if (req.query.stationId) filter.stationId = req.query.stationId;
      if (req.query.assignmentId) filter.assignmentId = req.query.assignmentId;
      if (req.query.ids) {
        filter.ids = String(req.query.ids)
          .split(',')
          .map((id) => id.trim())
          .filter((id) => !!id);
      }

      const result = await service.exportScansToFile(format, filter);

      if (format === 'pdf') {
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', 'attachment; filename=tag-scans.pdf');
      } else if (format === 'excel') {
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', 'attachment; filename=tag-scans.xlsx');
      }

      // result may be { buffer, mimeType }
      if (result && result.buffer) {
        return res.send(result.buffer);
      }

      return res.status(500).json({ message: 'Failed to generate export' });
    } catch (error: any) {
      await ApiResponseHandler.error(req, res, error);
    }
  });


  // Same as debug route but without the `/debug` prefix so developers can call
  // `/api/tenant/:tenantId/post-site/:postSiteId/tag-scans` during development.
  // Still blocked in production to avoid accidental exposure.
  router.get('/tenant/:tenantId/post-site/:postSiteId/tag-scans', async (req, res, next) => {
    try {
      // SECURITY: require auth + scope strictly to the authenticated tenant —
      // never trust the URL :tenantId (that was a cross-tenant IDOR).
      new PermissionChecker(req).validateHas(Permissions.values.postSiteRead);
      const tenantId = req.currentTenant.id;
      const postSiteId = req.params.postSiteId;

      const sql = `
        SELECT
          ts.*, 
          t.tagIdentifier AS tagIdentifier, 
          t.name AS tagName, 
          st.id AS tourId, 
          st.tenantId AS tourTenantId,
          s.id AS stationId,
          COALESCE(s.stationName, '') AS stationName,
          COALESCE(g.fullName, u.fullName, CONCAT(u.firstName, ' ', u.lastName), g2.fullName, u2.fullName, CONCAT(u2.firstName, ' ', u2.lastName), '') AS guardName,
          ta.id AS assignmentId
        FROM tagScans ts
        JOIN siteTourTags t ON ts.siteTourTagId = t.id
        JOIN siteTours st ON t.siteTourId = st.id
        LEFT JOIN stations s ON ts.stationId = s.id
        LEFT JOIN tourAssignments ta ON ts.tourAssignmentId = ta.id
        LEFT JOIN securityGuards g ON ts.securityGuardId = g.id
        LEFT JOIN users u ON g.guardId = u.id
        LEFT JOIN securityGuards g2 ON ta.securityGuardId = g2.id
        LEFT JOIN users u2 ON g2.guardId = u2.id
        WHERE st.postSiteId = :postSiteId AND (st.tenantId = :tenantId OR t.tenantId = :tenantId)
        ORDER BY ts.scannedAt DESC
        LIMIT 2000
      `;

      const replacements = { tenantId, postSiteId };
      const rows: any = await req.database.sequelize.query(sql, { replacements, type: req.database.sequelize.QueryTypes.SELECT });
      await ApiResponseHandler.success(req, res, { rows: rows || [], count: (rows || []).length });
    } catch (error) {
      await ApiResponseHandler.error(req, res, error);
    }
  });
}
