/**
 * GET /api/customer/post-site/:postSiteId/active-status
 *
 * Mobile app endpoint. Returns the active status for a specific post site:
 *   - postSite basic info
 *   - allAssignedGuards: guards scheduled for any upcoming shift at this site
 *   - stations: each station with activeGuards (on shift NOW) + nextShift
 *
 * Auth: Bearer token issued by POST /auth/sign-in-customer
 * The clientAccountId from JWT must own the requested postSiteId.
 */

import ApiResponseHandler from '../apiResponseHandler';
import Error400 from '../../errors/Error400';
import FileRepository from '../../database/repositories/fileRepository';
import Error401 from '../../errors/Error401';
import Error403 from '../../errors/Error403';

export default async (req: any, res: any) => {
  try {
    const currentUser = req.currentUser;
    if (!currentUser) throw new Error401();

    const { postSiteId } = req.params;
    const clientAccountId = currentUser.clientAccountId;
    const tenantId = currentUser.tenantId || (req.currentTenant && req.currentTenant.id);
    const db = req.database;
    const now = new Date();

    if (!clientAccountId) {
      throw new Error400(req.language, 'auth.clientAccountNotFound');
    }

    // ── 1. Verify the post site belongs to this client account ───────────────
    const postSite = await db.businessInfo.findOne({
      where: {
        id: postSiteId,
        clientAccountId,
        ...(tenantId ? { tenantId } : {}),
        deletedAt: null,
      },
      attributes: ['id', 'companyName', 'address', 'latitud', 'longitud', 'contactPhone', 'contactEmail'],
    });

    if (!postSite) {
      throw new Error403(req.language);
    }

    const postSitePlain = postSite.get({ plain: true });

    // ── 2. Stations ──────────────────────────────────────────────────────────
    const stationsRaw = await db.station.findAll({
      where: { postSiteId, ...(tenantId ? { tenantId } : {}), deletedAt: null },
      attributes: ['id', 'stationName', 'latitud', 'longitud'],
      order: [['stationName', 'ASC']],
    });

    const stationIds: string[] = stationsRaw.map((s: any) => s.id);

    // ── 3. Active shifts (NOW within window) ─────────────────────────────────
    const activeShiftsRaw = stationIds.length
      ? await db.shift.findAll({
          where: {
            ...(tenantId ? { tenantId } : {}),
            stationId: stationIds,
            startTime: { [db.Sequelize.Op.lte]: now },
            endTime: { [db.Sequelize.Op.gte]: now },
            deletedAt: null,
          },
          attributes: ['id', 'stationId', 'guardId', 'startTime', 'endTime'],
        })
      : [];

    // ── 4. Upcoming shifts next 7 days ───────────────────────────────────────
    const sevenDaysAhead = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const upcomingShiftsRaw = stationIds.length
      ? await db.shift.findAll({
          where: {
            ...(tenantId ? { tenantId } : {}),
            stationId: stationIds,
            startTime: { [db.Sequelize.Op.gt]: now, [db.Sequelize.Op.lte]: sevenDaysAhead },
            deletedAt: null,
          },
          attributes: ['id', 'stationId', 'guardId', 'startTime', 'endTime'],
          order: [['startTime', 'ASC']],
        })
      : [];

    // Also get all guards ever assigned to this post site (via tenant_user_client_accounts)
    let allAssignedGuardsRaw: any[] = [];
    try {
      const [rows] = await db.sequelize.query(
        `SELECT DISTINCT sg.id as securityGuardId, sg.fullName, sg.isOnDuty, sg.guardId
         FROM tenant_user_client_accounts tuca
         JOIN tenantUsers tu ON tu.id = tuca.tenantUserId
         JOIN securityGuards sg ON sg.guardId = tu.userId AND sg.tenantId = tu.tenantId
         WHERE tuca.clientAccountId = :clientAccountId
           AND tuca.deletedAt IS NULL
           AND tu.deletedAt IS NULL
           AND sg.deletedAt IS NULL
           ${tenantId ? 'AND tu.tenantId = :tenantId' : ''}`,
        { replacements: { clientAccountId, tenantId } },
      );
      allAssignedGuardsRaw = Array.isArray(rows) ? rows : [];
    } catch (e) {
      allAssignedGuardsRaw = [];
    }

    // ── 5. Load full guard details + photos ──────────────────────────────────
    const allGuardIds = new Set<string>();
    [...activeShiftsRaw, ...upcomingShiftsRaw].forEach((s: any) => {
      if (s.guardId) allGuardIds.add(s.guardId);
    });
    allAssignedGuardsRaw.forEach((g: any) => {
      if (g.guardId) allGuardIds.add(g.guardId);
    });

    const guardRecordIdsByUserId = new Map<string, string>();
    allAssignedGuardsRaw.forEach((g: any) => {
      guardRecordIdsByUserId.set(g.guardId, g.securityGuardId);
    });

    const guardMap = new Map<string, any>();

    if (allGuardIds.size > 0) {
      const guardsForShifts = await db.securityGuard.findAll({
        where: { guardId: Array.from(allGuardIds), ...(tenantId ? { tenantId } : {}), deletedAt: null },
        attributes: [
          'id', 'fullName', 'isOnDuty', 'guardId', 'governmentId',
          'bloodType', 'birthDate', 'birthPlace', 'maritalStatus',
          'academicInstruction', 'address', 'guardCredentials',
          'hiringContractDate', 'gender', 'availability', 'languages', 'skills',
        ],
      });
      guardsForShifts.forEach((g: any) => {
        if (!guardRecordIdsByUserId.has(g.guardId)) {
          guardRecordIdsByUserId.set(g.guardId, g.id);
        }
        guardMap.set(g.guardId, {
          ...g.get({ plain: true }),
          securityGuardId: g.id,
          photoUrl: null,
        });
      });
    }

    // Batch load photos
    const allGuardRecordIds = Array.from(guardRecordIdsByUserId.values());
    if (allGuardRecordIds.length) {
      const photoRecords = await db.file.findAll({
        where: {
          belongsTo: db.securityGuard.getTableName(),
          belongsToId: allGuardRecordIds,
          belongsToColumn: 'profileImage',
          deletedAt: null,
        },
        attributes: ['belongsToId', 'publicUrl', 'privateUrl'],
      });
      // Sign each photo into a fetchable URL (private selfie → signed downloadUrl).
      const photos = await FileRepository.fillDownloadUrl(photoRecords);
      for (const p of photos) {
        const url = (p as any).downloadUrl || p.publicUrl || null;
        if (!url) continue;
        // find the guardUserId for this record
        for (const [userId, recId] of guardRecordIdsByUserId.entries()) {
          if (recId === p.belongsToId) {
            const entry = guardMap.get(userId);
            if (entry && !entry.photoUrl) entry.photoUrl = url;
            break;
          }
        }
      }
    }

    // ── 6. Assemble allAssignedGuards list ────────────────────────────────────
    const allAssignedGuards = allAssignedGuardsRaw.map((g: any) => {
      const mapEntry = guardMap.get(g.guardId);
      return {
        ...(mapEntry || {}),
        id: g.guardId,
        securityGuardId: g.securityGuardId,
        fullName: mapEntry?.fullName || g.fullName,
        isOnDuty: mapEntry?.isOnDuty === 1 || mapEntry?.isOnDuty === true || g.isOnDuty === 1 || g.isOnDuty === true,
        photoUrl: mapEntry?.photoUrl || null,
      };
    });

    // ── 7. Per-station active status ──────────────────────────────────────────
    const activeByStation = new Map<string, any[]>();
    for (const s of activeShiftsRaw) {
      const arr = activeByStation.get(s.stationId) || [];
      arr.push(s);
      activeByStation.set(s.stationId, arr);
    }

    const nextByStation = new Map<string, any>();
    for (const s of upcomingShiftsRaw) {
      if (!nextByStation.has(s.stationId)) nextByStation.set(s.stationId, s);
    }

    const stations = stationsRaw.map((station: any) => {
      const sp = station.get({ plain: true });
      const activeShifts = activeByStation.get(sp.id) || [];
      const activeGuards = activeShifts
        .map((s: any) => guardMap.get(s.guardId))
        .filter(Boolean);
      const isActive = activeGuards.length > 0;
      const nextShiftRaw = !isActive ? nextByStation.get(sp.id) : null;

      return {
        id: sp.id,
        stationName: sp.stationName,
        latitud: sp.latitud,
        longitud: sp.longitud,
        isActive,
        activeGuards,
        nextShift: nextShiftRaw
          ? {
              startTime: nextShiftRaw.startTime,
              endTime: nextShiftRaw.endTime,
              guard: guardMap.get(nextShiftRaw.guardId) || null,
            }
          : null,
      };
    });

    return ApiResponseHandler.success(req, res, {
      postSite: postSitePlain,
      stations,
      allAssignedGuards,
    });
  } catch (error) {
    return ApiResponseHandler.error(req, res, error);
  }
};
