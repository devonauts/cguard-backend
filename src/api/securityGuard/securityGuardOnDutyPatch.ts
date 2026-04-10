import PermissionChecker from '../../services/user/permissionChecker';
import Error403 from '../../errors/Error403';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import SecurityGuardRepository from '../../database/repositories/securityGuardRepository';
import GuardShiftRepository from '../../database/repositories/guardShiftRepository';
import PatrolLogRepository from '../../database/repositories/patrolLogRepository';
import IncidentRepository from '../../database/repositories/incidentRepository';
// Use any for `req`/`res` because repository helpers expect a request-like
// object with additional properties (currentUser, currentTenant, language,
// etc.). Typing `req` as Express.Request caused incompatibilities with
// the internal `IRepositoryOptions` shape used throughout the codebase.

// PATCH /tenant/:tenantId/security-guard/:id/on-duty
export default async (req: any, res: any) => {
  try {
    // Allow supervisors/HR with `securityGuardEdit`, or allow the security guard
    // user themself to toggle their on-duty status.
    const checker = new PermissionChecker(req);
    const permission = Permissions.values.securityGuardEdit;
    if (!checker.has(permission)) {
      // If user lacks the edit permission, allow only if the currentUser is the
      // linked `guard` (user) for this securityGuard record.
      const targetId = req.params.id;
      console.log('[DEBUG][onDutyPatch] targetId=', targetId);
      console.log('[DEBUG][onDutyPatch] currentUser=', (req as any).currentUser && { id: (req as any).currentUser.id });
      let guardRecord: any = null;
      try {
        guardRecord = await SecurityGuardRepository.findById(targetId, req);
        console.log('[DEBUG][onDutyPatch] guardRecord found=', guardRecord && { id: (guardRecord as any).id, guardId: (guardRecord as any).guardId });
      } catch (err) {
        // propagate not-found error (will be handled below)
        throw err;
      }

      const guardUserId = guardRecord && ((guardRecord as any).guardId || ((guardRecord as any).guard && ((guardRecord as any).guard as any).id));
      const currentUserId = (req as any).currentUser && (req as any).currentUser.id;
      if (!currentUserId || !guardUserId || String(currentUserId) !== String(guardUserId)) {
        throw new Error403((req as any).language);
      }
    }

    const targetId = req.params.id;
    const {
      isOnDuty,
      stationNameId,
      postSiteId,
      shiftSchedule,
      observations,
      patrolsDone, // array de IDs
      dailyIncidents, // array de IDs
      punchInLatitude,
      punchInLongitude,
      punchOutLatitude,
      punchOutLongitude,
    } = req.body;

    if (typeof isOnDuty !== 'boolean') {
      return ApiResponseHandler.error(req, res, {
        message: 'isOnDuty debe ser booleano',
        code: 400,
      });
    }

    // Resolve the actual securityGuard record (the :id param might be the
    // securityGuard.id or the linked user id (guardId). Use findById which
    // handles both cases, then update by the resolved securityGuard.id.
    let targetRecord: any = null;
    try {
      targetRecord = await SecurityGuardRepository.findById(targetId, req);
      if (!targetRecord) {
        throw new Error('Registro de securityGuard no encontrado');
      }
    } catch (errResolve) {
      console.error('[ERROR][onDutyPatch] findById failed for targetId=', targetId, (errResolve as any) && (errResolve as any).stack ? (errResolve as any).stack : errResolve);
      throw errResolve;
    }

    try {
      console.log('[DEBUG][onDutyPatch] before update resolvedId=', (targetRecord as any).id, 'tenant=', (req as any).currentTenant && (req as any).currentTenant.id);
      const updated: any = await SecurityGuardRepository.update((targetRecord as any).id, { isOnDuty }, req);
      console.log('[DEBUG][onDutyPatch] update result=', updated && { id: updated.id, isOnDuty: updated.isOnDuty });
      var _updatedResult: any = updated;
    } catch (errUpdate) {
      console.error('[ERROR][onDutyPatch] update failed', (errUpdate as any) && (errUpdate as any).stack ? (errUpdate as any).stack : errUpdate);
      throw errUpdate;
    }

    // Obtener info básica del guardia
    const guard: any = _updatedResult || (targetRecord || {});
    const guardNameId = guard && guard.id;

    if (isOnDuty) {
      // Abrir turno: si ya existe un turno abierto para este guardia, no crear otro
      const existing = await GuardShiftRepository.findAndCountAll({
        filter: {
          guardName: guardNameId,
          punchOutTimeRange: [null, null],
        },
        limit: 1,
        orderBy: 'punchInTime_DESC',
      }, req);

      const hasOpen = existing && existing.rows && existing.rows.length > 0;
      if (hasOpen) {
        console.log('[DEBUG][onDutyPatch] existing open shift found for guard, skipping create');
      } else {
        // Crear nuevo turno
        const createData = {
          punchInTime: new Date(),
          shiftSchedule: shiftSchedule || 'Diurno',
          stationName: stationNameId,
          guardName: guardNameId,
          postSite: postSiteId,
          punchInLatitude: typeof punchInLatitude === 'number' ? punchInLatitude : (req.body.punchInLatitude ?? null),
          punchInLongitude: typeof punchInLongitude === 'number' ? punchInLongitude : (req.body.punchInLongitude ?? null),
          observations: observations || 'Inicio de turno',
          numberOfIncidentsDurindShift: typeof req.body.numberOfIncidentsDurindShift === 'number' ? req.body.numberOfIncidentsDurindShift : 0,
          patrolsDone: patrolsDone || [],
          dailyIncidents: dailyIncidents || [],
        };
        console.log('[DEBUG][onDutyPatch] createData=', createData);
        await GuardShiftRepository.create(createData, req);
      }

    } else {
      // Cerrar turno: buscar todos los guardShift abiertos y cerrarlos
      const { rows } = await GuardShiftRepository.findAndCountAll({
        filter: {
          guardName: guardNameId,
          punchOutTimeRange: [null, null],
        },
        orderBy: 'punchInTime_DESC',
      }, req);
      const openShifts: any[] = rows || [];
      if (!openShifts || openShifts.length === 0) {
        return ApiResponseHandler.error(req, res, {
          message: 'No se encontró un turno abierto para cerrar',
          code: 400,
        });
      }

      // Contar patrullas e incidentes relacionados
      const firstShift: any = openShifts[0];

      // Resolve FK ids robustly (fields may be populated as relation objects)
      const resolvedStationId = stationNameId || (firstShift && ((firstShift.stationName && (firstShift.stationName.id || firstShift.stationName)) || firstShift.stationNameId)) || null;
      const resolvedGuardId = guardNameId || (firstShift && ((firstShift.guardName && (firstShift.guardName.id || firstShift.guardName)) || firstShift.guardNameId)) || guardNameId;
      const resolvedPostSiteId = postSiteId || (firstShift && ((firstShift.postSite && (firstShift.postSite.id || firstShift.postSite)) || firstShift.postSiteId)) || null;
      let patrolCount = 0;
      let incidentCount = 0;
      let patrolsDoneIds = patrolsDone || [];
      let dailyIncidentsIds = dailyIncidents || [];

      if (Array.isArray(patrolsDoneIds) && patrolsDoneIds.length > 0) {
        patrolCount = patrolsDoneIds.length;
      } else {
        // Si no se envían, contar los relacionados
        patrolCount = ((firstShift as any).patrolsDone || []).length;
        patrolsDoneIds = ((firstShift as any).patrolsDone || []).map((p: any) => p.id);
      }
      if (Array.isArray(dailyIncidentsIds) && dailyIncidentsIds.length > 0) {
        incidentCount = dailyIncidentsIds.length;
      } else {
        incidentCount = ((firstShift as any).dailyIncidents || []).length;
        dailyIncidentsIds = ((firstShift as any).dailyIncidents || []).map((i: any) => i.id);
      }

      // Preserve foreign keys and postSite from the existing shift if not provided
      const updatePayload: any = {
        punchOutTime: new Date(),
        shiftSchedule: shiftSchedule || firstShift.shiftSchedule,
        observations: observations || firstShift.observations,
        numberOfPatrolsDuringShift: patrolCount,
        numberOfIncidentsDurindShift: incidentCount,
        patrolsDone: patrolsDoneIds,
        dailyIncidents: dailyIncidentsIds,
        punchOutLatitude: typeof punchOutLatitude === 'number' ? punchOutLatitude : (req.body.punchOutLatitude ?? null),
        punchOutLongitude: typeof punchOutLongitude === 'number' ? punchOutLongitude : (req.body.punchOutLongitude ?? null),
        // ensure we don't overwrite required FKs with nulls
        stationName: resolvedStationId,
        guardName: resolvedGuardId,
        postSite: resolvedPostSiteId,
      };
      console.log('[DEBUG][onDutyPatch] updatePayload for closing shift=', updatePayload);
      // Actualizar todos los turnos abiertos (por seguridad en caso de duplicados)
      for (const s of openShifts) {
        const sStation = (s as any).stationName && ((s as any).stationName.id || (s as any).stationName) || (s as any).stationNameId || null;
        const sGuard = (s as any).guardName && ((s as any).guardName.id || (s as any).guardName) || (s as any).guardNameId || guardNameId;
        const sPost = (s as any).postSite && ((s as any).postSite.id || (s as any).postSite) || (s as any).postSiteId || null;
        const payloadForShift = {
          ...updatePayload,
          stationName: updatePayload.stationName || sStation,
          guardName: updatePayload.guardName || sGuard,
          postSite: updatePayload.postSite || sPost,
        };
        console.log('[DEBUG][onDutyPatch] closing shift id=', (s as any).id, 'payload=', payloadForShift);
        await GuardShiftRepository.update((s as any).id, payloadForShift, req);
      }
    }

    await ApiResponseHandler.success(req, res, guard);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
