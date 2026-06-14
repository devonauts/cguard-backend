/**
 * SuperAdmin · training addon catalog + grants.
 * Mounted under /api/superadmin by ./index.ts, behind requireSuperadmin, so
 * every handler can assume an authenticated platform superadmin caller and may
 * query models cross-tenant off req.database (no tenant filter).
 *
 * Addon courses are trainingCourse rows with isAddon=true and tenantId=null
 * (platform catalog). Granting an addon to a tenant creates an addonCourseGrant
 * row; an active grant = the tenant has access to that course.
 */
import ApiResponseHandler from '../apiResponseHandler';
import { db, actor, writeAudit, listParams } from '../../services/superadmin/superadminHelpers';

export default (router: any) => {
  // POST /training/addon-courses — create a platform addon course.
  router.post('/training/addon-courses', async (req: any, res: any) => {
    try {
      const database = db(req);
      const data = req.body.data || req.body || {};
      if (!data.title) return ApiResponseHandler.error(req, res, { code: 400, message: 'title required' });
      const who = actor(req);
      const course = await database.trainingCourse.create({
        title: data.title,
        description: data.description ?? null,
        coverUrl: data.coverUrl ?? null,
        category: data.category ?? null,
        level: data.level ?? null,
        pointsValue: Number.isFinite(Number(data.pointsValue)) ? Number(data.pointsValue) : 0,
        passingScore: Number.isFinite(Number(data.passingScore)) ? Number(data.passingScore) : 70,
        certificateTemplate: data.certificateTemplate ?? null,
        addonPrice: data.addonPrice != null ? Number(data.addonPrice) : null,
        isAddon: true,
        published: data.published === true,
        tenantId: null,
        createdById: who.id || null,
        updatedById: who.id || null,
      });
      await writeAudit(req, {
        action: 'training.addon.create',
        targetType: 'trainingCourse',
        targetId: course.id,
        statusCode: 200,
      });
      await ApiResponseHandler.success(req, res, course);
    } catch (error) {
      await ApiResponseHandler.error(req, res, error);
    }
  });

  // GET /training/addon-courses — list platform addon catalog.
  router.get('/training/addon-courses', async (req: any, res: any) => {
    try {
      const database = db(req);
      const { limit, offset } = listParams(req.query);
      const result = await database.trainingCourse.findAndCountAll({
        where: { isAddon: true, deletedAt: null },
        limit,
        offset,
        order: [['createdAt', 'DESC']],
      });
      await ApiResponseHandler.success(req, res, { rows: result.rows, count: result.count });
    } catch (error) {
      await ApiResponseHandler.error(req, res, error);
    }
  });

  // POST /training/grants — grant (and optionally sell) an addon to a tenant.
  router.post('/training/grants', async (req: any, res: any) => {
    try {
      const database = db(req);
      const data = req.body.data || req.body || {};
      if (!data.addonCourseId || !data.tenantId) {
        return ApiResponseHandler.error(req, res, { code: 400, message: 'addonCourseId and tenantId required' });
      }
      const course = await database.trainingCourse.findOne({
        where: { id: data.addonCourseId, isAddon: true, deletedAt: null },
      });
      if (!course) return ApiResponseHandler.error(req, res, { code: 404, message: 'Addon course not found' });

      const tenant = await database.tenant.findByPk(data.tenantId);
      if (!tenant) return ApiResponseHandler.error(req, res, { code: 404, message: 'Tenant not found' });

      const who = actor(req);
      let grant = await database.addonCourseGrant.findOne({
        where: { addonCourseId: data.addonCourseId, tenantId: data.tenantId, deletedAt: null },
      });
      if (grant) {
        await grant.update({
          status: 'active',
          expiresAt: data.expiresAt ? new Date(data.expiresAt) : grant.expiresAt,
          seatCount: data.seatCount != null ? Number(data.seatCount) : grant.seatCount,
          pricePaid: data.pricePaid != null ? Number(data.pricePaid) : grant.pricePaid,
          grantedById: who.id || grant.grantedById,
        });
      } else {
        grant = await database.addonCourseGrant.create({
          addonCourseId: data.addonCourseId,
          tenantId: data.tenantId,
          grantedAt: new Date(),
          expiresAt: data.expiresAt ? new Date(data.expiresAt) : null,
          seatCount: data.seatCount != null ? Number(data.seatCount) : null,
          pricePaid: data.pricePaid != null ? Number(data.pricePaid) : null,
          status: 'active',
          grantedById: who.id || null,
        });
      }
      await writeAudit(req, {
        action: 'training.addon.grant',
        targetType: 'addonCourseGrant',
        targetId: grant.id,
        tenantId: data.tenantId,
        statusCode: 200,
        details: { addonCourseId: data.addonCourseId, pricePaid: data.pricePaid ?? null },
      });
      await ApiResponseHandler.success(req, res, grant);
    } catch (error) {
      await ApiResponseHandler.error(req, res, error);
    }
  });

  // GET /training/grants — which tenants have which addons.
  router.get('/training/grants', async (req: any, res: any) => {
    try {
      const database = db(req);
      const { limit, offset } = listParams(req.query);
      const where: any = { deletedAt: null };
      if (req.query.tenantId) where.tenantId = req.query.tenantId;
      const result = await database.addonCourseGrant.findAndCountAll({
        where,
        limit,
        offset,
        order: [['grantedAt', 'DESC']],
        include: [
          { model: database.trainingCourse, as: 'addonCourse', required: false },
          { model: database.tenant, as: 'tenant', required: false },
        ],
      });
      const rows = result.rows.map((g: any) => ({
        id: g.id,
        addonCourseId: g.addonCourseId,
        courseTitle: g.addonCourse ? g.addonCourse.title : null,
        tenantId: g.tenantId,
        tenantName: g.tenant ? g.tenant.name : null,
        currentEnrollments: g.currentEnrollments,
        seatCount: g.seatCount,
        status: g.status,
        expiresAt: g.expiresAt,
        pricePaid: g.pricePaid,
      }));
      await ApiResponseHandler.success(req, res, { rows, count: result.count });
    } catch (error) {
      await ApiResponseHandler.error(req, res, error);
    }
  });
};
