/**
 * GET /api/customer/me/account
 *
 * Returns the full account snapshot for the authenticated customer.
 * The clientAccountId is read from the JWT (set by /auth/sign-in-customer).
 *
 * Response shape:
 * {
 *   clientAccount: { id, name, email, phone, address, onboardingStatus, ... },
 *   postSites: [{ id, name, address, lat, lng, stations: [{ id, stationName, lat, lng }] }],
 *   guards: [{ id, fullName, isOnDuty, phone, photo }],
 *   incidents: [{ id, title, description, incidentAt, severity, postSiteId }],
 *   activeShifts: [{ id, startTime, endTime, guardId, postSiteId }],
 *   inventory: [{ id, name, quantity, stationId }],
 * }
 */

import ApiResponseHandler from '../apiResponseHandler';
import Error400 from '../../errors/Error400';
import Error401 from '../../errors/Error401';
import { Op } from 'sequelize';

export default async (req: any, res: any) => {
  try {
    const currentUser = req.currentUser;
    if (!currentUser) {
      throw new Error401();
    }

    const clientAccountId = currentUser.clientAccountId;
    if (!clientAccountId) {
      throw new Error400(req.language, 'auth.clientAccountNotFound');
    }

    const db = req.database;
    const tenantId = currentUser.tenantId || (req.currentTenant && req.currentTenant.id);

    // ── 1. Client account record ─────────────────────────────────────────────
    const clientAccount = await db.clientAccount.findOne({
      where: { id: clientAccountId, ...(tenantId ? { tenantId } : {}) },
      attributes: [
        'id', 'name', 'lastName', 'email', 'phoneNumber', 'address', 'addressComplement',
        'city', 'country', 'zipCode', 'documentNumber', 'active', 'onboardingStatus',
        'tenantId', 'createdAt',
      ],
    });

    if (!clientAccount) {
      throw new Error400(req.language, 'auth.clientAccountNotFound');
    }

    const plain = clientAccount.get({ plain: true });

    // ── 2. Post sites (businessInfo) ─────────────────────────────────────────
    const postSitesRaw = await db.businessInfo.findAll({
      where: { clientAccountId, ...(tenantId ? { tenantId } : {}) },
      attributes: ['id', 'companyName', 'address', 'city', 'country', 'latitud', 'longitud', 'contactPhone', 'contactEmail'],
    });

    const postSiteIds = postSitesRaw.map((p: any) => p.id);

    // Stations grouped per post site
    const stationsRaw = postSiteIds.length
      ? await db.station.findAll({
          where: { postSiteId: postSiteIds, ...(tenantId ? { tenantId } : {}) },
          attributes: ['id', 'stationName', 'latitud', 'longitud', 'postSiteId'],
        })
      : [];

    const stationsByPostSite: Record<string, any[]> = {};
    for (const s of stationsRaw) {
      const sp = s.get({ plain: true });
      if (!stationsByPostSite[sp.postSiteId]) stationsByPostSite[sp.postSiteId] = [];
      stationsByPostSite[sp.postSiteId].push({
        id: sp.id,
        stationName: sp.stationName,
        latitud: sp.latitud,
        longitud: sp.longitud,
      });
    }

    const postSites = postSitesRaw.map((p: any) => {
      const pp = p.get({ plain: true });
      return { ...pp, stations: stationsByPostSite[pp.id] || [] };
    });

    // ── 3. Assigned security guards ──────────────────────────────────────────
    // Guards are linked via tenant_user_client_accounts (tenantUser → securityGuard)
    let guards: any[] = [];
    try {
      const sequelize = db.sequelize;
      const [guardRows] = await sequelize.query(
        `SELECT DISTINCT sg.id, sg.fullName, sg.phone, sg.isOnDuty, sg.gender
         FROM tenant_user_client_accounts tuca
         JOIN tenantUsers tu ON tu.id = tuca.tenantUserId
         JOIN securityGuards sg ON sg.tenantUserId = tu.id
         WHERE tuca.clientAccountId = :clientAccountId
           AND tuca.deletedAt IS NULL
           AND tu.deletedAt IS NULL
           AND sg.deletedAt IS NULL
           ${tenantId ? 'AND (tu.tenantId = :tenantId OR tuca.tenantId = :tenantId)' : ''}`,
        { replacements: { clientAccountId, tenantId } },
      );
      guards = Array.isArray(guardRows) ? guardRows : [];
    } catch (e) {
      guards = [];
    }

    // ── 4. Recent incidents (last 30 days) ───────────────────────────────────
    let incidents: any[] = [];
    if (postSiteIds.length) {
      try {
        const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
        const rows = await db.incident.findAll({
          where: {
            postSiteId: postSiteIds,
            ...(tenantId ? { tenantId } : {}),
            [Op.or]: [
              { incidentAt: { [Op.gte]: thirtyDaysAgo } },
              { date: { [Op.gte]: thirtyDaysAgo } },
              { createdAt: { [Op.gte]: thirtyDaysAgo } },
            ],
          },
          attributes: ['id', 'title', 'description', 'incidentAt', 'date', 'severity', 'postSiteId', 'createdAt'],
          order: [['createdAt', 'DESC']],
          limit: 50,
        });
        incidents = rows.map((r: any) => r.get({ plain: true }));
      } catch (e) {
        incidents = [];
      }
    }

    // ── 5. Active / upcoming shifts ──────────────────────────────────────────
    let activeShifts: any[] = [];
    if (postSiteIds.length) {
      try {
        const now = new Date();
        const sevenDaysAhead = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
        const rows = await db.shift.findAll({
          where: {
            postSiteId: postSiteIds,
            ...(tenantId ? { tenantId } : {}),
            startTime: { [Op.lte]: sevenDaysAhead },
            endTime: { [Op.gte]: now },
          },
          attributes: ['id', 'startTime', 'endTime', 'postSiteId', 'guardId', 'tenantUserId'],
          order: [['startTime', 'ASC']],
          limit: 100,
        });
        activeShifts = rows.map((r: any) => r.get({ plain: true }));
      } catch (e) {
        activeShifts = [];
      }
    }

    // ── 6. Inventory items per station ───────────────────────────────────────
    let inventory: any[] = [];
    const stationIds = stationsRaw.map((s: any) => s.id);
    if (stationIds.length) {
      try {
        const rows = await db.inventory.findAll({
          where: {
            belongsToStation: stationIds,
            ...(tenantId ? { tenantId } : {}),
          },
          limit: 200,
        });
        inventory = rows.map((r: any) => r.get({ plain: true }));
      } catch (e) {
        inventory = [];
      }
    }

    return ApiResponseHandler.success(req, res, {
      clientAccount: plain,
      postSites,
      guards,
      incidents,
      activeShifts,
      inventory,
    });
  } catch (error) {
    return ApiResponseHandler.error(req, res, error);
  }
};
