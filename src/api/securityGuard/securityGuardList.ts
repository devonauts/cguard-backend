/**
 * @openapi {
 *  "summary": "List guards",
 *  "description": "List security guards with pagination and filters. Requires authentication.",
 *  "responses": { "200": { "description": "Paginated list" } }
 * }
 */
import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import SecurityGuardService from '../../services/securityGuardService';

export default async (req, res, next) => {
  try {
    new PermissionChecker(req).validateHas(
      Permissions.values.securityGuardRead,
    );

    // Normalize query args: build { filter, limit, offset, orderBy }
    const raw = req.query || {};

    let args: any = {};

    // If frontend already sent a nested filter object, use it
    if (raw.filter && typeof raw.filter === 'object') {
      args.filter = raw.filter;
    } else {
      args.filter = {};
      // Support keys like filter[archived]=true or filter.status=active
      for (const key of Object.keys(raw)) {
        if (key.startsWith('filter[')) {
          // e.g. filter[archived]
          const inner = key.replace(/^filter\[(.*)\]$/, '$1');
          args.filter[inner] = raw[key];
        } else if (key.startsWith('filter.')) {
          const inner = key.replace(/^filter\.(.*)$/, '$1');
          args.filter[inner] = raw[key];
        }
      }
    }

    // Also copy pagination/order params if present
    if (raw.limit) args.limit = raw.limit;
    if (raw.offset) args.offset = raw.offset;
    if (raw.orderBy) args.orderBy = raw.orderBy;

    // Default: include archived (soft-deleted) records so frontend can show
    // all guards with their respective statuses unless caller explicitly
    // requests otherwise.
    if (!Object.prototype.hasOwnProperty.call(args, 'filter') || typeof args.filter !== 'object') {
      args.filter = args.filter || {};
    }
    if (!Object.prototype.hasOwnProperty.call(args.filter, 'includeDeleted') && !Object.prototype.hasOwnProperty.call(args.filter, 'archived')) {
      args.filter.includeDeleted = true;
    }

    const payload = await new SecurityGuardService(
      req,
    ).findAndCountAll(args);

    // Temporary debug logs to help diagnose mismatched counts
    try {
      const tenantIdDebug = req.currentTenant && req.currentTenant.id ? req.currentTenant.id : null;
      const rowsCount = payload && Array.isArray(payload.rows) ? payload.rows.length : (payload && payload.rows ? Object.keys(payload.rows).length : 0);
      const reportedCount = payload && typeof payload.count === 'number' ? payload.count : null;
      console.debug('[securityGuardList] debug:', { tenantId: tenantIdDebug, rowsCount, reportedCount, sampleRows: (payload && payload.rows ? (Array.isArray(payload.rows) ? payload.rows.slice(0,5).map(r=>({id:r.id, guardId: r.guardId || r.guard && r.guard.id, fullName: r.fullName})) : payload.rows) : null) });
    } catch (e: any) {
      console.warn('[securityGuardList] debug logging failed', e && e.message ? e.message : e);
    }

    await ApiResponseHandler.success(req, res, payload);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
