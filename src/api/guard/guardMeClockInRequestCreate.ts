/**
 * POST /api/tenant/:tenantId/guard/me/clock-in/request   { reason?, stationId }
 *
 * The guard requests permission to clock in LATE (past the scheduled start +
 * the station/tenant late-grace window). Creates a pending clockInRequest for
 * today and notifies the post-site supervisors.
 *
 * Idempotent + retry-safe: if an open pending/approved request already exists
 * for this guard+station today it is returned as-is. Re-requesting RE-NOTIFIES
 * supervisors, but rate-limited to once per RENOTIFY_COOLDOWN_MS so a stuck
 * request can be nudged without looping or spamming the CRM.
 */
import ApiResponseHandler from '../apiResponseHandler';
import Error400 from '../../errors/Error400';
import Error401 from '../../errors/Error401';
import { Op } from 'sequelize';
import { dispatch } from '../../lib/notificationDispatcher';
import { matchScheduledShift } from '../../services/attendanceService';

const RENOTIFY_COOLDOWN_MS = 5 * 60 * 1000; // re-notify supervisors at most every 5 min

/** Last time we emitted a clock-in-request notification for this request. */
async function lastNotifiedAt(db: any, requestId: string): Promise<Date | null> {
  try {
    const [rows] = await db.sequelize.query(
      `SELECT createdAt FROM platform_events
        WHERE sourceEntityId = ? AND eventType = 'attendance.clockin_requested'
        ORDER BY createdAt DESC LIMIT 1`,
      { replacements: [requestId] },
    );
    const at = (rows as any[])[0]?.createdAt;
    return at ? new Date(at) : null;
  } catch {
    return null;
  }
}

async function notifySupervisors(
  db: any,
  tenantId: string,
  request: any,
  guardName: string,
  station: any,
): Promise<void> {
  try {
    await dispatch(
      'attendance.clockin_requested',
      {
        guardName: guardName || 'Guardia',
        stationName: station?.stationName || null,
        reason: request.reason || null,
      },
      {
        database: db,
        tenantId,
        sourceEntityType: 'clockInRequest',
        sourceEntityId: request.id,
        assignedPostSiteId: station?.postSiteId || undefined,
      },
    );
  } catch (e) {
    console.error('[clockInRequest] dispatch failed:', (e as any)?.message || e);
  }
}

export default async (req: any, res: any) => {
  try {
    const currentUser = req.currentUser;
    if (!currentUser) throw new Error401();
    const db = req.database;
    const userId = currentUser.id;
    const tenantId = req.params.tenantId || (req.currentTenant && req.currentTenant.id);
    const data = (req.body && req.body.data) || req.body || {};
    const stationId = data.stationId;

    if (!stationId) throw new Error400(req.language, 'guard.stationRequired');

    const securityGuard = await db.securityGuard.findOne({
      where: { guardId: userId, tenantId, deletedAt: null },
      attributes: ['id', 'fullName'],
    });
    if (!securityGuard) throw new Error400(req.language, 'guard.profileNotFound');

    const station = await db.station.findOne({
      where: { id: stationId, tenantId, deletedAt: null },
      attributes: ['id', 'stationName', 'postSiteId'],
    });
    if (!station) throw new Error400(req.language, 'guard.notAssignedToStation');

    // Tenant-local day window so "today" is correct.
    const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(); endOfDay.setHours(23, 59, 59, 999);

    // Reuse an open pending/approved request for this guard+station TODAY.
    const existing = await db.clockInRequest.findOne({
      where: {
        guardUserId: userId,
        stationId,
        tenantId,
        status: ['pending', 'approved'],
        createdAt: { [Op.gte]: startOfDay, [Op.lte]: endOfDay },
        deletedAt: null,
      },
      order: [['createdAt', 'DESC']],
    });
    if (existing) {
      let reNotified = false;
      if (existing.status === 'pending') {
        const last = await lastNotifiedAt(db, existing.id);
        if (!last || Date.now() - last.getTime() >= RENOTIFY_COOLDOWN_MS) {
          await notifySupervisors(db, tenantId, existing, securityGuard.fullName, station);
          reNotified = true;
        }
      }
      return ApiResponseHandler.success(req, res, {
        request: { ...existing.get({ plain: true }), reNotified },
      });
    }

    // Resolve the matched shift so the request carries shift context.
    const now = new Date();
    const match = await matchScheduledShift(db, {
      guardUserId: userId,
      stationId,
      tenantId,
      at: now,
    });

    // Fallback: the requested station may have no generated shift (the guard
    // picked a post they aren't scheduled at, or generation lag). Use whatever
    // shift is covering NOW for this guard at ANY station, so the request still
    // carries the real scheduled start it's "late" against — otherwise the CRM
    // approval row shows an empty "Inicio de turno".
    let scheduledStart: Date | null = match.scheduledStart || null;
    let shiftId: string | null = match.shiftId || null;
    if (!scheduledStart) {
      const active = await db.shift.findOne({
        where: {
          guardId: userId, tenantId,
          startTime: { [Op.lte]: now },
          endTime: { [Op.gte]: now },
        },
        attributes: ['id', 'startTime'],
        order: [['startTime', 'DESC']],
      });
      if (active) {
        scheduledStart = active.startTime;
        shiftId = shiftId || active.id;
      }
    }

    const request = await db.clockInRequest.create({
      guardUserId: userId,
      guardId: securityGuard.id,
      stationId,
      shiftId,
      scheduledStart,
      reason: data.reason ? String(data.reason).slice(0, 500) : null,
      status: 'pending',
      tenantId,
      createdById: userId,
      updatedById: userId,
    });

    await notifySupervisors(db, tenantId, request, securityGuard.fullName, station);

    return ApiResponseHandler.success(req, res, { request: request.get({ plain: true }) });
  } catch (error) {
    return ApiResponseHandler.error(req, res, error);
  }
};
