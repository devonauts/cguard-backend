/**
 * GET /api/customer/me/account
 *
 * Returns the full account snapshot for the authenticated customer.
 * The clientAccountId is read from the JWT (set by /auth/sign-in-customer).
 *
 * Optional query: ?include=guards,incidents,patrols (comma-separated; omit for all)
 *
 * Response shape:
 * {
 *   clientAccount: { id, name, email, phone, address, onboardingStatus, logoUrl: [...], placePictureUrl: [...] },
 *   postSites: [{ id, name, address, lat, lng, stations: [{ id, stationName, lat, lng,
 *                stationSchedule, startingTimeInDay, finishTimeInDay, numberOfGuardsInStation }] }],
 *   guards: [{ id, fullName, isOnDuty, phone, photo }],
 *   incidents: [{ id, title, description, incidentAt, severity, postSiteId }],
 *   activeShifts: [{ id, startTime, endTime, guardId, postSiteId }],
 *   inventory: [{ id, name, belongsToStation, radio, radioType, radioSerialNumber,
 *                gun, gunType, gunSerialNumber, armor, armorType, armorSerialNumber,
 *                armorExpirationDate, tolete, pito, linterna, vitacora, cintoCompleto,
 *                ponchoDeAguas, detectorDeMetales, caseta, observations, transportation }],
 *   patrols: [{ id, scheduledTime, completionTime, status, completed, station, assignedGuard }],
 * }
 */

import ApiResponseHandler from '../apiResponseHandler';
import Error400 from '../../errors/Error400';
import Error401 from '../../errors/Error401';
import { Op } from 'sequelize';
import FileRepository from '../../database/repositories/fileRepository';
import BannerSuperiorAppService from '../../services/bannerSuperiorAppService';
import CertificationService from '../../services/certificationService';
import ServiceService from '../../services/serviceService';

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

    // Parse include param: if provided, only include those relation keys
    // Example: ?include=guards,incidents
    const includeParam = (req.query && req.query.include) ? String(req.query.include) : '';
    const rawIncludeList = includeParam.split(',').map((s) => s.trim().toLowerCase()).filter((s) => s.length > 0);
    const includeAll = rawIncludeList.length === 0;

    // support aliases and normalization (case-insensitive)
    const aliasMap: Record<string, string> = {
      guards: 'guards',
      guard: 'guards',
      incidents: 'incidents',
      incident: 'incidents',
      activeshifts: 'activeShifts',
      activeshift: 'activeShifts',
      shifts: 'activeShifts',
      shift: 'activeShifts',
      inventory: 'inventory',
      inventories: 'inventory',
      postsites: 'postSites',
      postsite: 'postSites',
      posts: 'postSites',
      stations: 'postSites',
      patrols: 'patrols',
      patrol: 'patrols',
      rondas: 'patrols',
      banner: 'banner',
      banners: 'banner',
      certifications: 'certifications',
      certification: 'certifications',
      certs: 'certifications',
      mobileservices: 'mobileServices',
      mobileservice: 'mobileServices',
      services: 'mobileServices',
      service: 'mobileServices',
    };

    const includeSet = new Set<string>();
    for (const raw of rawIncludeList) {
      const mapped = aliasMap[raw] || raw;
      includeSet.add(mapped);
    }

    const shouldInclude = (key: string) => includeAll || includeSet.has(key);

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

    // ── 1b. Logo and place picture ───────────────────────────────────────────
    try {
      const clientAccountTable = db.clientAccount.getTableName();
      const logoFiles = await db.file.findAll({
        where: { belongsTo: clientAccountTable, belongsToId: clientAccountId, belongsToColumn: 'logoUrl', deletedAt: null },
      });
      const placeFiles = await db.file.findAll({
        where: { belongsTo: clientAccountTable, belongsToId: clientAccountId, belongsToColumn: 'placePictureUrl', deletedAt: null },
      });
      plain.logoUrl = await FileRepository.fillDownloadUrl(logoFiles);
      plain.placePictureUrl = await FileRepository.fillDownloadUrl(placeFiles);
    } catch (e) {
      plain.logoUrl = [];
      plain.placePictureUrl = [];
    }

    // ── 2. Post sites (businessInfo) ─────────────────────────────────────────
    const postSitesRaw = await db.businessInfo.findAll({
      where: { clientAccountId, ...(tenantId ? { tenantId } : {}) },
      attributes: ['id', 'companyName', 'address', 'city', 'country', 'latitud', 'longitud', 'contactPhone', 'contactEmail'],
    });

    const postSiteIds = postSitesRaw.map((p: any) => p.id);

    // DEBUG: log postSite ids
    console.debug('[customerAccountMe] postSiteIds:', postSiteIds);

    // Stations grouped per post site
    const stationsRaw = postSiteIds.length
      ? await db.station.findAll({
          where: { postSiteId: postSiteIds, ...(tenantId ? { tenantId } : {}) },
          attributes: ['id', 'stationName', 'latitud', 'longitud', 'postSiteId',
                       'stationSchedule', 'startingTimeInDay', 'finishTimeInDay',
                       'numberOfGuardsInStation'],
        })
      : [];

    console.debug('[customerAccountMe] stationsRaw count:', Array.isArray(stationsRaw) ? stationsRaw.length : 0);

    // Shifts are keyed by stationId (the canonical link — see customerPostSiteActiveStatus),
    // NOT postSiteId, so resolve the station ids up-front for the shift/inventory/patrol queries.
    const stationIds = stationsRaw.map((s: any) => s.id);

    const stationsByPostSite: Record<string, any[]> = {};
    for (const s of stationsRaw) {
      const sp = s.get({ plain: true });
      if (!stationsByPostSite[sp.postSiteId]) stationsByPostSite[sp.postSiteId] = [];
      stationsByPostSite[sp.postSiteId].push({
        id: sp.id,
        stationName: sp.stationName,
        latitud: sp.latitud,
        longitud: sp.longitud,
        stationSchedule: sp.stationSchedule,
        startingTimeInDay: sp.startingTimeInDay,
        finishTimeInDay: sp.finishTimeInDay,
        numberOfGuardsInStation: sp.numberOfGuardsInStation,
      });
    }

    const postSites = postSitesRaw.map((p: any) => {
      const pp = p.get({ plain: true });
      return { ...pp, stations: stationsByPostSite[pp.id] || [] };
    });

    // ── 3. Assigned security guards ──────────────────────────────────────────
    // Guards are linked via tenant_user_client_accounts (tenantUser → securityGuard)
    let guards: any[] = [];
    if (shouldInclude('guards')) {
      try {
        const sequelize = db.sequelize;
        // A client's guards are those EITHER explicitly linked via the
        // tenant_user_client_accounts pivot OR actually working at the client's
        // post-sites (a current/upcoming shift). The pivot is frequently empty
        // because guards are assigned through the scheduling engine (shifts), not
        // that pivot — so relying on it alone returned ZERO guards even when guards
        // were on duty. Union both sources so "guardias trabajando" always shows.
        const [guardRows] = await sequelize.query(
          `SELECT DISTINCT
             sg.id, sg.fullName, sg.isOnDuty, sg.gender, sg.governmentId,
             sg.bloodType, sg.birthDate, sg.birthPlace, sg.maritalStatus,
             sg.academicInstruction, sg.address, sg.guardCredentials,
             sg.hiringContractDate, sg.availability, sg.languages, sg.skills,
             sg.guardId
           FROM securityGuards sg
           WHERE sg.deletedAt IS NULL
             ${tenantId ? 'AND sg.tenantId = :tenantId' : ''}
             AND sg.guardId IN (
               -- (1) explicitly linked via the client pivot
               SELECT tu.userId
               FROM tenant_user_client_accounts tuca
               JOIN tenantUsers tu ON tu.id = tuca.tenantUserId
               WHERE tuca.clientAccountId = :clientAccountId
                 AND tuca.deletedAt IS NULL
                 AND tu.deletedAt IS NULL
               UNION
               -- (2) ACTIVELY ASSIGNED to one of the client's stations — same source as
               --     the CRM "vigilantes asignados", so an empty station shows no guards.
               SELECT ga.guardId
               FROM guardAssignments ga
               JOIN stations st ON st.id = ga.stationId
               JOIN businessInfos b ON b.id = st.postSiteId
               WHERE b.clientAccountId = :clientAccountId
                 AND ga.status = 'active'
                 AND ga.deletedAt IS NULL
                 AND ga.guardId IS NOT NULL
               UNION
               -- (3) covering one of the client's stations via an upcoming shift, e.g. a
               --     GLOBAL sacafranco whose home assignment is on another station.
               SELECT s.guardId
               FROM shifts s
               JOIN stations st ON st.id = s.stationId
               JOIN businessInfos b ON b.id = st.postSiteId
               WHERE b.clientAccountId = :clientAccountId
                 AND s.guardId IS NOT NULL
                 AND s.endTime >= NOW()
                 AND s.startTime <= DATE_ADD(NOW(), INTERVAL 7 DAY)
                 AND s.deletedAt IS NULL
             )`,
          { replacements: { clientAccountId, tenantId } },
        );
        const rawGuards = Array.isArray(guardRows) ? guardRows : [];

        // Load profile photos for all guards
        const guardRecordIds = rawGuards.map((g: any) => g.id).filter(Boolean);
        const guardPhotoRecords = guardRecordIds.length
          ? await db.file.findAll({
              where: {
                belongsTo: db.securityGuard.getTableName(),
                belongsToId: guardRecordIds,
                belongsToColumn: 'profileImage',
                deletedAt: null,
              },
              attributes: ['belongsToId', 'publicUrl', 'privateUrl'],
            })
          : [];
        // Sign each guard photo into a fetchable downloadUrl. The worker-app selfie is stored
        // privately, so the raw privateUrl path isn't loadable by the apps (only the CRM signed
        // it) — fillDownloadUrl mints the same signed URL the logo/visitor photos use.
        const guardPhotos = await FileRepository.fillDownloadUrl(guardPhotoRecords);
        const photoByGuardId = new Map<string, string>();
        for (const p of guardPhotos) {
          const url = (p as any).downloadUrl || p.publicUrl || null;
          if (url && !photoByGuardId.has(p.belongsToId)) photoByGuardId.set(p.belongsToId, url);
        }

        guards = rawGuards.map((g: any) => ({
          ...g,
          photoUrl: photoByGuardId.get(g.id) || null,
        }));
      } catch (e) {
        guards = [];
      }
    }

    // ── 4. Recent incidents (last 30 days) ───────────────────────────────────
    let incidents: any[] = [];
    if (shouldInclude('incidents') && postSiteIds.length) {
      try {
        console.debug('[customerAccountMe] fetching incidents postSiteIds:', postSiteIds, 'tenantId:', tenantId);
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
          // NOTE: the incident model has NO `severity` column — the severity-like
          // field is `priority`. Selecting `severity` here threw a "column does not
          // exist" error that the catch below swallowed, so incidents ALWAYS came
          // back as []. Select `priority` and surface it as `severity` for clients.
          attributes: ['id', 'title', 'description', 'incidentAt', 'date', 'priority', 'postSiteId', 'createdAt'],
          order: [['createdAt', 'DESC']],
          limit: 50,
        });
        incidents = rows.map((r: any) => {
          const p = r.get({ plain: true });
          p.severity = p.priority ?? null;
          return p;
        });
        console.debug('[customerAccountMe] incidents count:', incidents.length);
      } catch (e) {
        incidents = [];
      }
    }

    // ── 5. Active / upcoming shifts ──────────────────────────────────────────
    let activeShifts: any[] = [];
    if (shouldInclude('activeShifts') && stationIds.length) {
      try {
        console.debug('[customerAccountMe] fetching shifts stationIds:', stationIds, 'tenantId:', tenantId);
        const now = new Date();
        const sevenDaysAhead = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
        const rows = await db.shift.findAll({
          where: {
            stationId: stationIds,
            ...(tenantId ? { tenantId } : {}),
            startTime: { [Op.lte]: sevenDaysAhead },
            endTime: { [Op.gte]: now },
          },
          attributes: ['id', 'startTime', 'endTime', 'stationId', 'postSiteId', 'guardId', 'tenantUserId'],
          order: [['startTime', 'ASC']],
          limit: 100,
        });
        activeShifts = rows.map((r: any) => r.get({ plain: true }));
        console.debug('[customerAccountMe] activeShifts count:', activeShifts.length);
      } catch (e) {
        activeShifts = [];
      }
    }

    // ── 6. Inventory items per station ───────────────────────────────────────
    let inventory: any[] = [];
    if (shouldInclude('inventory') && stationIds.length) {
      try {
        console.debug('[customerAccountMe] fetching inventory stationIds:', stationIds, 'tenantId:', tenantId);
        const rows = await db.inventory.findAll({
          where: {
            belongsToStation: stationIds,
            ...(tenantId ? { tenantId } : {}),
          },
          limit: 200,
        });
        inventory = rows.map((r: any) => r.get({ plain: true }));
        console.debug('[customerAccountMe] inventory count:', inventory.length);
      } catch (e) {
        inventory = [];
      }
    }

    // ── 7. Recent patrols (last 7 days) ──────────────────────────────────────
    // The patrol FK column is `stationId` (the `station` belongsTo alias), NOT
    // `station`. Filter by it and attach a nested `station` object so the apps
    // can render station name + coordinates (PatrolModel.station.stationName).
    let patrols: any[] = [];
    if (shouldInclude('patrols') && stationIds.length) {
      try {
        const stationById: Record<string, any> = {};
        for (const s of stationsRaw) {
          const sp = s.get({ plain: true });
          stationById[sp.id] = {
            id: sp.id,
            stationName: sp.stationName,
            latitud: sp.latitud,
            longitud: sp.longitud,
          };
        }

        const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        const rows = await db.patrol.findAll({
          where: {
            stationId: stationIds,
            ...(tenantId ? { tenantId } : {}),
            [Op.or]: [
              { scheduledTime: { [Op.gte]: sevenDaysAgo } },
              { createdAt: { [Op.gte]: sevenDaysAgo } },
            ],
          },
          attributes: ['id', 'scheduledTime', 'completionTime', 'status', 'completed', 'stationId', 'assignedGuardId', 'updatedAt'],
          order: [['scheduledTime', 'DESC']],
          limit: 100,
        });
        patrols = rows.map((r: any) => {
          const p = r.get({ plain: true });
          p.station = stationById[p.stationId] || null;
          return p;
        });
        console.debug('[customerAccountMe] patrols count:', patrols.length);
      } catch (e) {
        patrols = [];
      }
    }

    // ── 8. Company dashboard assets: banner + certifications + mobile services ──
    // FULL objects (with signed images) so the dashboard renders in ONE call —
    // no buried ids + N follow-up fetches. Tenant-scoped via the same services the
    // CRM uses. Each is best-effort: a failure yields [] without breaking the call.
    if (tenantId) req.currentTenant = { id: tenantId };
    let banner: any[] = [];
    let certifications: any[] = [];
    let mobileServices: any[] = [];
    if (tenantId && shouldInclude('banner')) {
      try {
        const r = await new BannerSuperiorAppService(req).findAndCountAll({ filter: {}, limit: 0 });
        banner = Array.isArray(r.rows) ? r.rows : [];
      } catch (e) { banner = []; }
    }
    if (tenantId && shouldInclude('certifications')) {
      try {
        const r = await new CertificationService(req).findAndCountAll({ filter: {}, limit: 0 });
        certifications = Array.isArray(r.rows) ? r.rows : [];
      } catch (e) { certifications = []; }
    }
    if (tenantId && shouldInclude('mobileServices')) {
      try {
        const r = await new ServiceService(req).findAndCountAll({ filter: {}, limit: 0 });
        // Only services explicitly published to the mobile app (the CRM publish toggle).
        mobileServices = (Array.isArray(r.rows) ? r.rows : []).filter(
          (s: any) => s && (s.publishedOnMobile === true || s.publishedOnMobile === 1),
        );
      } catch (e) { mobileServices = []; }
    }

    // Build response object. `clientAccount` always present. Other keys
    // returned only if requested (or when no include param provided).
    const response: any = { clientAccount: plain };
    if (shouldInclude('postSites')) response.postSites = postSites;
    if (shouldInclude('guards')) response.guards = guards;
    if (shouldInclude('banner')) response.banner = banner;
    if (shouldInclude('certifications')) response.certifications = certifications;
    if (shouldInclude('mobileServices')) response.mobileServices = mobileServices;
    if (shouldInclude('incidents')) response.incidents = incidents;
    if (shouldInclude('activeShifts')) response.activeShifts = activeShifts;
    if (shouldInclude('inventory')) response.inventory = inventory;
    if (shouldInclude('patrols')) response.patrols = patrols;

    return ApiResponseHandler.success(req, res, response);
  } catch (error) {
    return ApiResponseHandler.error(req, res, error);
  }
};
