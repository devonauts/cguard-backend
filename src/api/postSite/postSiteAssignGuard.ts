/** @openapi { "summary": "Assign a guard to a post site / station (creates a guardAssignment)", "requestBody": { "content": { "application/json": { "schema": { "type": "object", "properties": { "guardId": { "type": "string" }, "securityGuardId": { "type": "string" }, "tenantUserId": { "type": "string" }, "stationId": { "type": "string" }, "startDate": { "type": "string" }, "endDate": { "type": "string" }, "startTime": { "type": "string" }, "endTime": { "type": "string" } }, "required": [] } } } }, "responses": { "200": { "description": "Assignment created" }, "400": { "description": "Bad Request" } } } */

import PermissionChecker from '../../services/user/permissionChecker';
import Permissions from '../../security/permissions';
import ApiResponseHandler from '../apiResponseHandler';
import { createAssignment, AssignmentValidationError } from '../../services/assignmentService';

/**
 * Thin adapter over the single assignment write path. Bound to both
 * `post-site/:id/assign-guard` and `stations/:id/assign-guard`. It resolves the
 * guard's USER id + a concrete station, then creates an ad-hoc `guardAssignment`
 * (which auto-generates the shifts read everywhere). No pivot/side-table writes.
 */
export default async (req, res) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.userEdit);

    const tenantId = req.params.tenantId;
    const routeId = req.params.id; // may be a postSiteId or a stationId depending on the mounted route
    const incoming = req.body.data || req.body || {};

    // 1) Resolve the guard USER id (assignments key on users.id).
    let guardUserId: string | null = incoming.guardId || null;
    const candidate = guardUserId || incoming.securityGuardId || incoming.security_guard_id || null;
    if (!guardUserId && candidate) {
      // candidate may be a securityGuard record id or a user id — normalize to user id.
      const sg = await req.database.securityGuard.findOne({ where: { id: candidate, tenantId }, attributes: ['guardId'] });
      if (sg?.guardId) {
        guardUserId = sg.guardId;
      } else {
        const u = await req.database.user.findByPk(candidate, { attributes: ['id'] });
        if (u?.id) guardUserId = u.id;
      }
    }
    if (!guardUserId) {
      const tuId = incoming.tenantUserId || incoming.tenant_user_id || null;
      if (tuId) {
        const tu = await req.database.tenantUser.findOne({
          where: { id: tuId },
          include: [{ model: req.database.user, as: 'user', attributes: ['id'] }],
        });
        if (tu?.user?.id) guardUserId = tu.user.id;
      }
    }
    if (!guardUserId) {
      throw new AssignmentValidationError('guardId, securityGuardId or tenantUserId is required');
    }

    // 2) Resolve the target stationId. Prefer explicit; else the route id may be a
    //    station, else a post-site (use its first station).
    let stationId: string | null = incoming.stationId || incoming.station_id || null;
    if (!stationId && routeId) {
      const asStation = await req.database.station.findByPk(routeId, { attributes: ['id'] });
      if (asStation?.id) {
        stationId = asStation.id;
      } else {
        const st = await req.database.station.findOne({
          where: { postSiteId: routeId, tenantId, deletedAt: null },
          attributes: ['id'],
        });
        if (st?.id) stationId = st.id;
      }
    }
    if (!stationId) {
      throw new AssignmentValidationError('No se encontró una estación para asignar (envía stationId).');
    }

    // 2.5) Resolve a concrete OPEN position at the station so the guard is
    //      visible in the Horario grid. The grid renders strictly per position
    //      (assignment.positionId === position.id); a positionId-less assignment
    //      is created as ad-hoc and can NEVER appear there. Pick the first open
    //      puesto matching the guard's type (titular→fijo, sacafranco→sacafranco),
    //      falling back to the first of-type puesto so the guard still shows.
    let positionId: string | null = incoming.positionId || incoming.position_id || null;
    if (!positionId) {
      const sg = await req.database.securityGuard.findOne({
        where: { guardId: guardUserId, tenantId, deletedAt: null },
        attributes: ['guardType'],
      });
      const desiredType = sg?.guardType === 'sacafranco' ? 'sacafranco' : 'fijo';

      const stationPositions = await req.database.stationPosition.findAll({
        where: { stationId, tenantId, deletedAt: null },
        attributes: ['id', 'type', 'sortOrder'],
        order: [['sortOrder', 'ASC']],
      });
      if (stationPositions.length) {
        const occupied = new Set(
          (await req.database.guardAssignment.findAll({
            where: { stationId, tenantId, status: 'active', deletedAt: null },
            attributes: ['positionId'],
          }))
            .map((a: any) => a.positionId)
            .filter(Boolean),
        );
        const ofType = stationPositions.filter((p: any) => p.type === desiredType);
        const pool = ofType.length
          ? ofType
          : stationPositions.filter((p: any) => p.type !== 'sacafranco');
        const open = pool.find((p: any) => !occupied.has(p.id));
        positionId = (open || pool[0])?.id || null;
      }
    }

    // 3) Single write path → guardAssignment (auto-generates shifts). With a
    //    positionId it becomes a 'rotation' assignment that the Horario renders;
    //    only falls back to ad-hoc when the station has no positions configured.
    const today = new Date().toISOString().slice(0, 10);

    // Station ↔ turno are strictly linked: an assigned guard inherits the
    // station's schedule. Derive the window from the station's jornada so an
    // ad-hoc assignment covers the station's hours (for a rotation/position
    // assignment the position's own times remain authoritative).
    let schedStart = incoming.startTime || null;
    let schedEnd = incoming.endTime || null;
    try {
      const station = await req.database.station.findByPk(stationId, {
        attributes: ['startingTimeInDay', 'finishTimeInDay', 'stationSchedule'],
      });
      const raw = station?.stationSchedule;
      const arr = Array.isArray(raw)
        ? raw
        : (typeof raw === 'string' && raw.trim().startsWith('[') ? JSON.parse(raw) : null);
      const jornada = arr && arr.length ? arr[0] : null;
      schedStart = schedStart || jornada?.startTime || station?.startingTimeInDay || '07:00';
      schedEnd = schedEnd || jornada?.endTime || station?.finishTimeInDay || '19:00';
    } catch { /* fall back to defaults below */ }

    // Ad-hoc assignments default to a one-year horizon so the guard covers the
    // schedule going forward (not just a single day).
    const oneYear = new Date();
    oneYear.setFullYear(oneYear.getFullYear() + 1);
    const horizonEnd = oneYear.toISOString().slice(0, 10);

    try {
      const record = await createAssignment(req.database, tenantId, req.currentUser.id, {
        guardId: guardUserId,
        stationId,
        positionId,
        startDate: incoming.startDate || today,
        endDate: incoming.endDate || (positionId ? null : horizonEnd),
        startTime: schedStart || '07:00',
        endTime: schedEnd || '19:00',
      });
      await ApiResponseHandler.success(req, res, record);
    } catch (e: any) {
      if (e instanceof AssignmentValidationError) {
        res.status(400).send({ message: e.message });
        return;
      }
      throw e;
    }
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
