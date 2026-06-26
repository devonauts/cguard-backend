require('dotenv').config();

import models from '../models';
import { Op } from 'sequelize';

/**
 * Backfill station/postSite/client attribution on ORPHANED visitorLogs rows —
 * visits saved before the resilient server-side attribution landed in
 * visitorLogRepository.create(). Those rows have stationId + postSiteId +
 * clientId all NULL, so the visit is invisible to the client (Mi Seguridad) and
 * to post-scoped staff; only tenant admins (who see every row) can find it.
 *
 * For each orphaned row we re-derive the chain, ANCHORED TO THE VISIT'S OWN TIME
 * (visitDate, falling back to createdAt) rather than "now", in priority order:
 *   1) the scheduled shift that covered the visit,
 *   2) the attendance record (guardShift) the guard had OPEN at visit time,
 *   3) the guard's permanent station junction,
 *   4) any assigned post site.
 * Then it completes station → postSite → client and denormalizes stationName.
 *
 * Idempotent: only ever fills NULLs, and re-running re-selects only still-orphaned
 * rows. Safe to leave in the migration history.
 */
async function migrate() {
  const db = models();
  const { sequelize } = db;

  try {
    const orphans = await db.visitorLog.findAll({
      where: {
        [Op.and]: [
          { stationId: null },
          { postSiteId: null },
          { clientId: null },
          { createdById: { [Op.ne]: null } },
        ],
      },
      attributes: ['id', 'tenantId', 'createdById', 'visitDate', 'createdAt', 'stationName'],
    });

    console.log(`visitorLog backfill: ${orphans.length} orphaned row(s) to inspect.`);

    // cache: `${userId}|${tenantId}` -> securityGuard.id | null
    const sgCache = new Map<string, string | null>();
    const resolveSecurityGuardId = async (userId: string, tenantId: string) => {
      const key = `${userId}|${tenantId}`;
      if (sgCache.has(key)) return sgCache.get(key)!;
      const sg = await db.securityGuard
        .findOne({ where: { guardId: userId, tenantId, deletedAt: null }, attributes: ['id'] })
        .catch(() => null);
      const id = sg ? sg.id : null;
      sgCache.set(key, id);
      return id;
    };

    let updated = 0;
    let stillOrphan = 0;

    for (const row of orphans) {
      const userId = row.createdById;
      const tenantId = row.tenantId;
      const ts = row.visitDate ? new Date(row.visitDate) : new Date(row.createdAt);

      let stationId: string | null = null;
      let postSiteId: string | null = null;

      // 1) Scheduled shift covering the visit.
      const shift = await db.shift
        .findOne({
          where: {
            guardId: userId,
            tenantId,
            startTime: { [Op.lte]: ts },
            endTime: { [Op.gte]: ts },
          },
          order: [['startTime', 'DESC']],
          attributes: ['stationId', 'postSiteId'],
        })
        .catch(() => null);
      if (shift) {
        stationId = shift.stationId || null;
        postSiteId = shift.postSiteId || null;
      }

      // 2) Attendance record open at visit time (punched in, not yet out by then).
      if (!stationId && !postSiteId) {
        const sgId = await resolveSecurityGuardId(userId, tenantId);
        if (sgId) {
          const att = await db.guardShift
            .findOne({
              where: {
                guardNameId: sgId,
                tenantId,
                punchInTime: { [Op.lte]: ts },
                [Op.or]: [{ punchOutTime: null }, { punchOutTime: { [Op.gte]: ts } }],
              },
              order: [['punchInTime', 'DESC']],
              attributes: ['stationNameId', 'postSiteId'],
            })
            .catch(() => null);
          if (att) {
            stationId = att.stationNameId || null;
            postSiteId = att.postSiteId || null;
          }
        }
      }

      // 3) Permanent station junction.
      if (!stationId && !postSiteId) {
        const st = await db.station
          .findOne({
            where: { tenantId, deletedAt: null },
            attributes: ['id', 'postSiteId'],
            include: [{
              model: db.user,
              as: 'assignedGuards',
              where: { id: userId },
              attributes: [],
              through: { attributes: [] },
              required: true,
            }],
            order: [['createdAt', 'DESC']],
          })
          .catch(() => null);
        if (st) {
          stationId = st.id || null;
          postSiteId = st.postSiteId || null;
        }
      }

      // 4) Assigned post site (last resort).
      if (!postSiteId) {
        const tu = await db.tenantUser
          .findOne({
            where: { userId, tenantId },
            include: [{ model: db.businessInfo, as: 'assignedPostSites', attributes: ['id'] }],
          })
          .catch(() => null);
        const firstPost = tu && tu.assignedPostSites && tu.assignedPostSites[0];
        if (firstPost && firstPost.id) postSiteId = firstPost.id;
      }

      // station → postSite
      if (stationId && !postSiteId) {
        const st = await db.station.findByPk(stationId, { attributes: ['postSiteId'] }).catch(() => null);
        if (st && st.postSiteId) postSiteId = st.postSiteId;
      }
      // postSite → client
      let clientId: string | null = null;
      if (postSiteId) {
        const bi = await db.businessInfo.findByPk(postSiteId, { attributes: ['clientAccountId'] }).catch(() => null);
        if (bi && bi.clientAccountId) clientId = bi.clientAccountId;
      }

      // Denormalized station name.
      let stationName = row.stationName || null;
      if (!stationName && stationId) {
        const st = await db.station.findByPk(stationId).catch(() => null);
        if (st) stationName = st.stationName || st.name || null;
      }

      const updates: any = {};
      if (stationId) updates.stationId = stationId;
      if (postSiteId) updates.postSiteId = postSiteId;
      if (clientId) updates.clientId = clientId;
      if (stationName && !row.stationName) updates.stationName = stationName;

      if (Object.keys(updates).length) {
        await db.visitorLog.update(updates, { where: { id: row.id } });
        updated++;
      } else {
        stillOrphan++;
      }
    }

    console.log(`visitorLog backfill: updated ${updated} row(s); ${stillOrphan} could not be attributed (no schedule/attendance/assignment found).`);
    process.exit(0);
  } catch (error) {
    console.error('visitorLog backfill failed:', error);
    process.exit(1);
  }
}

export { migrate };

migrate();
