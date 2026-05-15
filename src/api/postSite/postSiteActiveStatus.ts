/**
 * GET /tenant/:tenantId/post-site/:id/active-status
 *
 * Returns all stations for a post site, each enriched with:
 *   - activeGuards: guards currently on shift (startTime <= NOW <= endTime) with photo
 *   - nextShift: next upcoming shift if no one is active
 *
 * Used by both the web Resumen tab and the mobile app.
 */
import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';

export default async (req: any, res: any) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.stationRead);

    const { tenantId, id: postSiteId } = req.params;
    const db = req.database;
    const now = new Date();

    // ── 1. Stations for this post site ──────────────────────────────────────
    const stationsRaw = await db.station.findAll({
      where: { postSiteId, tenantId, deletedAt: null },
      attributes: ['id', 'stationName', 'latitud', 'longitud'],
      order: [['stationName', 'ASC']],
    });

    if (!stationsRaw.length) {
      return ApiResponseHandler.success(req, res, { stations: [] });
    }

    const stationIds: string[] = stationsRaw.map((s: any) => s.id);

    // ── 2. Currently active shifts (NOW is within [startTime, endTime]) ──────
    const activeShiftsRaw = await db.shift.findAll({
      where: {
        tenantId,
        stationId: stationIds,
        startTime: { [db.Sequelize.Op.lte]: now },
        endTime:   { [db.Sequelize.Op.gte]: now },
        deletedAt: null,
      },
      attributes: ['id', 'stationId', 'guardId', 'startTime', 'endTime'],
    });

    // ── 3. Next upcoming shifts per station (next 7 days) ────────────────────
    const sevenDaysAhead = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const upcomingShiftsRaw = await db.shift.findAll({
      where: {
        tenantId,
        stationId: stationIds,
        startTime: { [db.Sequelize.Op.gt]: now, [db.Sequelize.Op.lte]: sevenDaysAhead },
        deletedAt: null,
      },
      attributes: ['id', 'stationId', 'guardId', 'startTime', 'endTime'],
      order: [['startTime', 'ASC']],
    });

    // Collect all guardIds we need
    const allGuardIds = new Set<string>();
    [...activeShiftsRaw, ...upcomingShiftsRaw].forEach((s: any) => {
      if (s.guardId) allGuardIds.add(s.guardId);
    });

    // ── 4. Guard details + photo ─────────────────────────────────────────────
    const guardMap = new Map<string, any>();
    if (allGuardIds.size > 0) {
      const guardsRaw = await db.securityGuard.findAll({
        where: { guardId: Array.from(allGuardIds), tenantId, deletedAt: null },
        attributes: [
          'id', 'fullName', 'isOnDuty', 'guardId', 'governmentId',
          'bloodType', 'birthDate', 'birthPlace', 'maritalStatus',
          'academicInstruction', 'address', 'guardCredentials',
          'hiringContractDate', 'gender', 'availability', 'languages', 'skills',
        ],
      });

      // Batch load profile photos
      const guardRecordIds = guardsRaw.map((g: any) => g.id);
      const photos = guardRecordIds.length
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

      // Photo lookup: guardRecord.id → url
      const photoByGuardRecordId = new Map<string, string>();
      for (const p of photos) {
        const url = p.publicUrl || p.privateUrl || null;
        if (url && !photoByGuardRecordId.has(p.belongsToId)) {
          photoByGuardRecordId.set(p.belongsToId, url);
        }
      }

      for (const g of guardsRaw) {
        guardMap.set(g.guardId, {
          ...g.get({ plain: true }),
          securityGuardId: g.id,
          photoUrl: photoByGuardRecordId.get(g.id) || null,
        });
      }
    }

    // ── 5. Build per-station response ─────────────────────────────────────────
    // active shifts indexed by stationId
    const activeByStation = new Map<string, any[]>();
    for (const s of activeShiftsRaw) {
      const arr = activeByStation.get(s.stationId) || [];
      arr.push(s);
      activeByStation.set(s.stationId, arr);
    }

    // next upcoming shift indexed by stationId (first one only)
    const nextByStation = new Map<string, any>();
    for (const s of upcomingShiftsRaw) {
      if (!nextByStation.has(s.stationId)) {
        nextByStation.set(s.stationId, s);
      }
    }

    const stations = stationsRaw.map((station: any) => {
      const sp = station.get({ plain: true });
      const activeShifts = activeByStation.get(sp.id) || [];
      const activeGuards = activeShifts
        .map((s: any) => guardMap.get(s.guardId))
        .filter(Boolean);

      const isActive = activeGuards.length > 0;
      const nextShift = !isActive ? nextByStation.get(sp.id) : null;

      return {
        id: sp.id,
        stationName: sp.stationName,
        latitud: sp.latitud,
        longitud: sp.longitud,
        isActive,
        activeGuards,
        nextShift: nextShift
          ? {
              startTime: nextShift.startTime,
              endTime: nextShift.endTime,
              guard: guardMap.get(nextShift.guardId) || null,
            }
          : null,
      };
    });

    return ApiResponseHandler.success(req, res, { stations });
  } catch (error) {
    return ApiResponseHandler.error(req, res, error);
  }
};
