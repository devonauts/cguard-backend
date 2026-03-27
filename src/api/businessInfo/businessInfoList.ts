/**
 * @openapi {
 *  "summary": "List business info",
 *  "description": "List business infos (post sites) with pagination and filters. Requires authentication.",
 *  "responses": { "200": { "description": "Paginated list" } }
 * }
 */
import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import BusinessInfoService from '../../services/businessInfoService';
import ClientAccountService from '../../services/clientAccountService';

export default async (req, res, next) => {
  try {
    new PermissionChecker(req).validateHas(
      Permissions.values.businessInfoRead,
    );

    const payload = await new BusinessInfoService(
      req,
    ).findAndCountAll(req.query);

    // Attach client account name (name + lastName) when clientAccountId present
    try {
      if (payload && Array.isArray(payload.rows) && payload.rows.length) {
        const clientService = new ClientAccountService(req);
        const ids = Array.from(new Set(payload.rows
          .filter((r) => r.clientAccountId)
          .map((r) => r.clientAccountId),
        ));

        const clientsById = {};
        await Promise.all(ids.map(async (id) => {
          try {
            const c = await clientService.findById(id);
            clientsById[id] = c;
          } catch (e) {
            clientsById[id] = null;
          }
        }));

        payload.rows = payload.rows.map((r) => {
          const client = r.clientAccountId ? clientsById[r.clientAccountId] : null;
          const clientName = client ? `${client.name || ''} ${client.lastName || ''}`.trim() : null;

          // legacy compatibility: frontend originally expects `name`, `clientId`, and `client` object
          const legacyClient = client
            ? {
                id: client.id,
                name: client.name || null,
                lastName: client.lastName || null,
                email: client.email || null,
              }
            : null;

          return {
            ...r,
            clientAccountName: clientName,
            // legacy keys
            name: r.companyName,
            clientId: r.clientAccountId,
            client: legacyClient,
            // common aliases expected by older frontend
            latitude: r.latitud || r.latitude || null,
            longitude: r.longitud || r.longitude || null,
            phone: r.contactPhone || r.phone || null,
            email: r.contactEmail || r.email || null,
          };
        });
      }
    } catch (e) {
      console.error('Error logging businessInfoList payload:', e);
    }

    // Attach related counts (assignments, shifts, guardShifts) without
    // replacing the primary businessInfo data. This is a "union"-style
    // augmentation so frontend can show guard-related metrics per post site.
    try {
      if (payload && Array.isArray(payload.rows) && payload.rows.length) {
        const ids = payload.rows.map((r) => r.id).filter(Boolean);
        const replacements = { ids, tenantId: req.params.tenantId };

        // Count assignments using `shifts` as canonical source. Count any shift that
        // references the businessInfo via postSiteId OR via stationId.
        const shiftsSql = `
          SELECT COALESCE(postSiteId, stationId) as businessInfoId, COUNT(*) as shiftsCount
          FROM shifts
          WHERE (postSiteId IN (:ids) OR stationId IN (:ids))
            AND tenantId = :tenantId
          GROUP BY COALESCE(postSiteId, stationId)
        `;

        // Count guardShifts referencing stationNameId = businessInfo id
        const guardShiftsSql = `
          SELECT stationNameId as businessInfoId, COUNT(*) as guardShiftsCount
          FROM guardShifts
          WHERE stationNameId IN (:ids)
            AND tenantId = :tenantId
          GROUP BY stationNameId
        `;

        const shiftRows = await req.database.sequelize.query(shiftsSql, { replacements, type: req.database.sequelize.QueryTypes.SELECT });
        const gShiftRows = await req.database.sequelize.query(guardShiftsSql, { replacements, type: req.database.sequelize.QueryTypes.SELECT });
        const shiftMap = (shiftRows || []).reduce((acc, cur) => { acc[cur.businessInfoId] = Number(cur.shiftsCount); return acc; }, {});
        const gShiftMap = (gShiftRows || []).reduce((acc, cur) => { acc[cur.businessInfoId] = Number(cur.guardShiftsCount); return acc; }, {});

        payload.rows = payload.rows.map((r) => ({
          ...r,
          // `assignmentsCount` now derived from shifts (primary source) plus guardShifts
          assignmentsCount: (shiftMap[r.id] || 0) + (gShiftMap[r.id] || 0),
          shiftsCount: shiftMap[r.id] || 0,
          guardShiftsCount: gShiftMap[r.id] || 0,
        }));
      }
    } catch (e) {
      console.error('Error augmenting businessInfoList with station/assignment counts:', e);
    }

    // Temporary debug: log payload size to help diagnose frontend empty list issue
    try {
      const debugCount = payload && payload.count ? payload.count : (payload && Array.isArray(payload.rows) ? payload.rows.length : 0);
      console.debug(`[businessInfoList] tenant=${req.params.tenantId} rows=${debugCount} sample=${payload && payload.rows && payload.rows[0] ? payload.rows[0].id : 'no-row'}`);
    } catch (e) {
      console.debug('[businessInfoList] debug log failed', e);
    }

    // Prevent browser/proxy caching of this API response which can produce
    // 304 Not Modified responses and cause the frontend to receive no body.
    try {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    } catch (e) {
      // ignore header-setting errors
    }

    await ApiResponseHandler.success(req, res, payload);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
