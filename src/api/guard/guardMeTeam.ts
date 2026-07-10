/**
 * GET /api/tenant/:tenantId/guard/me/team
 *
 * Team roster for the guard's CURRENT sitio de servicio (post site). A sitio can
 * span many stations (e.g. a campus with 20–30 posts) — this returns the guards
 * on duty across all stations of that same sitio, and nobody from other sitios.
 *
 * Roster = active clock-ins (punchOutTime IS NULL) whose post site matches the
 * caller's, matched on the shift's stored postSiteId OR its station's postSiteId.
 */
import ApiResponseHandler from '../apiResponseHandler';
import Error401 from '../../errors/Error401';
import { Op } from 'sequelize';

export default async (req: any, res: any) => {
  try {
    const currentUser = req.currentUser;
    if (!currentUser) throw new Error401();

    const db = req.database;
    const userId = currentUser.id;
    const tenantId = req.params.tenantId || (req.currentTenant && req.currentTenant.id);

    const empty = { postSiteId: null, postSiteName: null, count: 0, members: [] as any[] };

    const securityGuard = await db.securityGuard.findOne({
      where: { guardId: userId, tenantId, deletedAt: null },
      attributes: ['id', 'fullName'],
    });
    if (!securityGuard) return ApiResponseHandler.success(req, res, empty);

    // My most recent active clock-in → resolve which sitio I'm working.
    // Lean attributes: guardShift rows carry heavy TEXT blobs (selfie,
    // sessions JSON) we must not hydrate here.
    const myShift = await db.guardShift.findOne({
      where: { guardNameId: securityGuard.id, tenantId, punchOutTime: null },
      attributes: ['id', 'postSiteId', 'stationNameId', 'punchInTime'],
      order: [['punchInTime', 'DESC']],
    });

    // Resolve the sitio (post site): shift snapshot → shift's station → my
    // assigned station.
    let postSiteId: string | null = myShift?.postSiteId || null;
    if (!postSiteId && myShift?.stationNameId) {
      const st = await db.station.findByPk(myShift.stationNameId, { attributes: ['id', 'postSiteId'] });
      postSiteId = st?.postSiteId || null;
    }
    if (!postSiteId) {
      const st = await db.station.findOne({
        where: { tenantId, deletedAt: null },
        include: [{
          model: db.user,
          as: 'assignedGuards',
          where: { id: userId },
          attributes: [],
          through: { attributes: [] },
        }],
        attributes: ['id', 'postSiteId'],
      });
      postSiteId = st?.postSiteId || null;
    }

    // No sitio resolvable → roster is just me, if I'm on duty.
    if (!postSiteId) {
      const members = myShift
        ? [{
            securityGuardId: securityGuard.id,
            fullName: securityGuard.fullName || 'Guardia',
            stationId: myShift.stationNameId || null,
            stationName: null,
            punchInTime: myShift.punchInTime,
            isMe: true,
          }]
        : [];
      return ApiResponseHandler.success(req, res, { ...empty, count: members.length, members });
    }

    const postSite = await db.businessInfo.findByPk(postSiteId, { attributes: ['id', 'companyName'] });

    // Active clock-ins at THIS sitio only — the postSite match (shift snapshot
    // OR its station's postSiteId) is pushed into SQL instead of fetching every
    // open shift tenant-wide and filtering in JS. Lean attributes (no selfie /
    // sessions blobs) + a backstop limit; both includes are belongsTo, so
    // subQuery:false keeps the $stationName.postSiteId$ reference valid.
    const shifts = await db.guardShift.findAll({
      where: {
        tenantId,
        punchOutTime: null,
        [Op.or]: [
          { postSiteId },
          { '$stationName.postSiteId$': postSiteId },
        ],
      },
      attributes: ['id', 'guardNameId', 'stationNameId', 'postSiteId', 'punchInTime'],
      include: [
        { model: db.securityGuard, as: 'guardName', attributes: ['id', 'fullName'], required: true },
        { model: db.station, as: 'stationName', attributes: ['id', 'stationName', 'postSiteId'], required: false },
      ],
      order: [['punchInTime', 'ASC']],
      limit: 500,
      subQuery: false,
    });

    const seen = new Set<string>();
    const members: any[] = [];
    for (const s of shifts) {
      const sameSitio = s.postSiteId === postSiteId || s.stationName?.postSiteId === postSiteId;
      if (!sameSitio) continue;
      const gid = s.guardName?.id || s.guardNameId;
      if (!gid || seen.has(gid)) continue; // one entry per guard
      seen.add(gid);
      members.push({
        securityGuardId: gid,
        fullName: s.guardName?.fullName || 'Guardia',
        stationId: s.stationName?.id || s.stationNameId || null,
        stationName: s.stationName?.stationName || null,
        punchInTime: s.punchInTime,
        isMe: gid === securityGuard.id,
      });
    }

    return ApiResponseHandler.success(req, res, {
      postSiteId,
      postSiteName: postSite?.companyName || null,
      count: members.length,
      members,
    });
  } catch (error) {
    return ApiResponseHandler.error(req, res, error);
  }
};
