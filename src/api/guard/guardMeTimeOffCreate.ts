/**
 * POST /api/tenant/:tenantId/guard/me/time-off
 * 
 * Guard creates a time-off request.
 * Body: { type, startDate, endDate, reason? }
 */
import ApiResponseHandler from '../apiResponseHandler';
import Error400 from '../../errors/Error400';
import Error401 from '../../errors/Error401';
import { dispatch } from '../../lib/notificationDispatcher';

export default async (req: any, res: any) => {
  try {
    const currentUser = req.currentUser;
    if (!currentUser) throw new Error401();

    const db = req.database;
    const userId = currentUser.id;
    const tenantId = req.params.tenantId || (req.currentTenant && req.currentTenant.id);

    const data = req.body.data || req.body;
    const { type, startDate, endDate, reason } = data;

    if (!type || !startDate || !endDate) {
      throw new Error400(req.language, 'guard.timeOff.requiredFields');
    }

    const securityGuard = await db.securityGuard.findOne({
      where: { guardId: userId, tenantId, deletedAt: null },
      attributes: ['id', 'fullName'],
    });

    if (!securityGuard) {
      throw new Error400(req.language, 'guard.profileNotFound');
    }

    // timeOffRequest.guardId is the USER id (the model FK → user, the CRM create,
    // and shift.guardId all use the user id). The worker previously wrote
    // securityGuard.id into the same column, which split identity: the CRM showed
    // "—" for the requester and the backup/volunteer pool never matched. Use
    // currentUser.id so worker and CRM rows are the same shape.
    // Idempotency: a double-submit (same guard, type, dates, still pending) must
    // not insert a duplicate request. Return the existing one instead.
    const duplicate = await db.timeOffRequest.findOne({
      where: {
        tenantId,
        guardId: userId,
        type,
        startDate,
        endDate,
        status: 'pending',
        deletedAt: null,
      },
    });
    if (duplicate) {
      return ApiResponseHandler.success(req, res, duplicate.get({ plain: true }));
    }

    const record = await db.timeOffRequest.create({
      guardId: userId,
      guardName: securityGuard.fullName,
      type,
      startDate,
      endDate,
      reason: reason || '',
      status: 'pending',
      tenantId,
      createdById: userId,
      updatedById: userId,
    });

    // CRM realtime feed (bell): HR/supervisors/admins see the request, like every
    // other guard action. Best-effort, fire-and-forget — never blocks the create.
    try {
      await dispatch(
        'timeoff.requested',
        {
          guardName: securityGuard.fullName || currentUser.fullName || 'Empleado',
          dateRange: `${startDate} – ${endDate}`,
          reason: reason || null,
        },
        {
          database: db,
          tenantId,
          sourceEntityType: 'timeOffRequest',
          sourceEntityId: record.id,
        },
      );
    } catch (e) {
      console.error('[timeOffCreate] dispatch failed:', (e as any)?.message || e);
    }

    return ApiResponseHandler.success(req, res, record.get({ plain: true }));
  } catch (error) {
    return ApiResponseHandler.error(req, res, error);
  }
};
