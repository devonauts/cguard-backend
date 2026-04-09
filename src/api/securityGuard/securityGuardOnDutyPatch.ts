import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import SecurityGuardRepository from '../../database/repositories/securityGuardRepository';
import GuardShiftRepository from '../../database/repositories/guardShiftRepository';
import PatrolLogRepository from '../../database/repositories/patrolLogRepository';
import IncidentRepository from '../../database/repositories/incidentRepository';

// PATCH /tenant/:tenantId/security-guard/:id/on-duty
export default async (req, res) => {
  try {
    new PermissionChecker(req).validateHas(
      Permissions.values.securityGuardEdit,
    );

    const targetId = req.params.id;
    const {
      isOnDuty,
      stationNameId,
      postSiteId,
      shiftSchedule,
      observations,
      patrolsDone, // array de IDs
      dailyIncidents, // array de IDs
    } = req.body;

    if (typeof isOnDuty !== 'boolean') {
      return ApiResponseHandler.error(req, res, {
        message: 'isOnDuty debe ser booleano',
        code: 400,
      });
    }

    // Actualiza el estado del guardia
    const updated = await SecurityGuardRepository.update(targetId, { isOnDuty }, req);

    // Obtener info básica del guardia
    const guard = updated;
    const guardNameId = guard.id;

    if (isOnDuty) {
      // Abrir turno: crear guardShift
      await GuardShiftRepository.create({
        punchInTime: new Date(),
        shiftSchedule: shiftSchedule || 'Diurno',
        stationName: stationNameId,
        guardName: guardNameId,
        postSite: postSiteId,
        observations: observations || '',
        patrolsDone: patrolsDone || [],
        dailyIncidents: dailyIncidents || [],
      }, req);
    } else {
      // Cerrar turno: buscar el último guardShift abierto
      const { rows } = await GuardShiftRepository.findAndCountAll({
        filter: {
          guardName: guardNameId,
          punchOutTimeRange: [null, null],
        },
        limit: 1,
        orderBy: 'punchInTime_DESC',
      }, req);
      const lastShift = rows && rows.length > 0 ? rows[0] : null;
      if (!lastShift) {
        return ApiResponseHandler.error(req, res, {
          message: 'No se encontró un turno abierto para cerrar',
          code: 400,
        });
      }

      // Contar patrullas e incidentes relacionados
      let patrolCount = 0;
      let incidentCount = 0;
      let patrolsDoneIds = patrolsDone || [];
      let dailyIncidentsIds = dailyIncidents || [];

      if (Array.isArray(patrolsDoneIds) && patrolsDoneIds.length > 0) {
        patrolCount = patrolsDoneIds.length;
      } else {
        // Si no se envían, contar los relacionados
        patrolCount = (lastShift.patrolsDone || []).length;
        patrolsDoneIds = (lastShift.patrolsDone || []).map(p => p.id);
      }
      if (Array.isArray(dailyIncidentsIds) && dailyIncidentsIds.length > 0) {
        incidentCount = dailyIncidentsIds.length;
      } else {
        incidentCount = (lastShift.dailyIncidents || []).length;
        dailyIncidentsIds = (lastShift.dailyIncidents || []).map(i => i.id);
      }

      await GuardShiftRepository.update(lastShift.id, {
        punchOutTime: new Date(),
        shiftSchedule: shiftSchedule || lastShift.shiftSchedule,
        observations: observations || lastShift.observations,
        numberOfPatrolsDuringShift: patrolCount,
        numberOfIncidentsDurindShift: incidentCount,
        patrolsDone: patrolsDoneIds,
        dailyIncidents: dailyIncidentsIds,
      }, req);
    }

    await ApiResponseHandler.success(req, res, updated);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
