/**
 * "Puestos de supervisor" API — configure a supervisor position (rotation + shift
 * window) and assign supervisors to it. Isolated from the guard engine; reuses
 * the shared rotationStyle table. Gated by the existing guard permissions.
 */
import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import Error404 from '../../errors/Error404';
import { regenerateForAssignment, regenerateForPosition } from '../../services/supervisorScheduleService';

const POS_FIELDS = ['name', 'zone', 'scheduleType', 'rotationStyleId', 'startTime', 'endTime', 'guardsNeeded', 'mobileStationId', 'stationIds', 'isActive'];
const ASG_FIELDS = ['supervisorUserId', 'startDate', 'endDate', 'platoonOffset', 'isRelief', 'status'];

const pick = (obj: any, keys: string[]) => keys.reduce((a: any, k) => { if (obj[k] !== undefined) a[k] = obj[k]; return a; }, {});
const body = (req: any) => (req.body && req.body.data) || req.body || {};

async function shapePosition(db: any, p: any) {
  const o = p.get ? p.get({ plain: true }) : p;
  const assignments = (o.assignments || []).map((a: any) => ({
    id: String(a.id),
    supervisorUserId: a.supervisorUserId ? String(a.supervisorUserId) : null,
    supervisorName: a.supervisor ? `${a.supervisor.firstName || ''} ${a.supervisor.lastName || ''}`.trim() || a.supervisor.fullName || a.supervisor.email : null,
    platoonOffset: a.platoonOffset ?? 0,
    isRelief: !!a.isRelief,
    startDate: a.startDate || null,
    status: a.status || 'active',
  }));
  return {
    id: String(o.id),
    name: o.name,
    zone: o.zone || null,
    scheduleType: o.scheduleType,
    rotationStyleId: o.rotationStyleId ? String(o.rotationStyleId) : null,
    rotationStyle: o.rotationStyle ? { id: String(o.rotationStyle.id), name: o.rotationStyle.name, dayShifts: o.rotationStyle.dayShifts, nightShifts: o.rotationStyle.nightShifts, restDays: o.rotationStyle.restDays } : null,
    startTime: o.startTime || null,
    endTime: o.endTime || null,
    guardsNeeded: o.guardsNeeded ?? 1,
    mobileStationId: o.mobileStationId ? String(o.mobileStationId) : null,
    stationIds: Array.isArray(o.stationIds) ? o.stationIds.map((x: any) => String(x)) : [],
    isActive: o.isActive !== false,
    assignments,
  };
}

function positionInclude(db: any) {
  return [
    { model: db.rotationStyle, as: 'rotationStyle', required: false },
    { model: db.supervisorPositionAssignment, as: 'assignments', required: false, where: { status: 'active' }, separate: false,
      include: [{ model: db.user, as: 'supervisor', attributes: ['id', 'firstName', 'lastName', 'fullName', 'email'], required: false }] },
  ];
}

export default (app) => {
  // LIST
  app.get('/tenant/:tenantId/supervisor-positions', async (req: any, res: any) => {
    try {
      new PermissionChecker(req).validateHas(Permissions.values.securityGuardRead);
      const db = req.database;
      const rows = await db.supervisorPosition.findAll({
        where: { tenantId: req.currentTenant.id },
        include: positionInclude(db),
        order: [['createdAt', 'DESC']],
      });
      const out: any[] = [];
      for (const r of rows) out.push(await shapePosition(db, r));
      await ApiResponseHandler.success(req, res, { rows: out, count: out.length });
    } catch (error) { await ApiResponseHandler.error(req, res, error); }
  });

  // DETAIL
  app.get('/tenant/:tenantId/supervisor-positions/:id', async (req: any, res: any) => {
    try {
      new PermissionChecker(req).validateHas(Permissions.values.securityGuardRead);
      const db = req.database;
      const rec = await db.supervisorPosition.findOne({ where: { id: req.params.id, tenantId: req.currentTenant.id }, include: positionInclude(db) });
      if (!rec) throw new Error404();
      await ApiResponseHandler.success(req, res, await shapePosition(db, rec));
    } catch (error) { await ApiResponseHandler.error(req, res, error); }
  });

  // CREATE
  app.post('/tenant/:tenantId/supervisor-positions', async (req: any, res: any) => {
    try {
      new PermissionChecker(req).validateHas(Permissions.values.securityGuardCreate);
      const db = req.database;
      const uid = req.currentUser?.id;
      const rec = await db.supervisorPosition.create({ ...pick(body(req), POS_FIELDS), tenantId: req.currentTenant.id, createdById: uid, updatedById: uid });
      const fresh = await db.supervisorPosition.findByPk(rec.id, { include: positionInclude(db) });
      await ApiResponseHandler.success(req, res, await shapePosition(db, fresh));
    } catch (error) { await ApiResponseHandler.error(req, res, error); }
  });

  // UPDATE
  app.put('/tenant/:tenantId/supervisor-positions/:id', async (req: any, res: any) => {
    try {
      new PermissionChecker(req).validateHas(Permissions.values.securityGuardEdit);
      const db = req.database;
      const rec = await db.supervisorPosition.findOne({ where: { id: req.params.id, tenantId: req.currentTenant.id } });
      if (!rec) throw new Error404();
      await rec.update({ ...pick(body(req), POS_FIELDS), updatedById: req.currentUser?.id });
      await regenerateForPosition(db, req.currentTenant.id, rec.id, req.currentUser?.id).catch(() => undefined);
      const fresh = await db.supervisorPosition.findByPk(rec.id, { include: positionInclude(db) });
      await ApiResponseHandler.success(req, res, await shapePosition(db, fresh));
    } catch (error) { await ApiResponseHandler.error(req, res, error); }
  });

  // DELETE
  app.delete('/tenant/:tenantId/supervisor-positions/:id', async (req: any, res: any) => {
    try {
      new PermissionChecker(req).validateHas(Permissions.values.securityGuardEdit);
      const db = req.database;
      const rec = await db.supervisorPosition.findOne({ where: { id: req.params.id, tenantId: req.currentTenant.id } });
      if (!rec) throw new Error404();
      await db.supervisorPositionAssignment.destroy({ where: { positionId: rec.id, tenantId: req.currentTenant.id } });
      await rec.destroy();
      await ApiResponseHandler.success(req, res, true);
    } catch (error) { await ApiResponseHandler.error(req, res, error); }
  });

  // ASSIGN a supervisor to the position
  app.post('/tenant/:tenantId/supervisor-positions/:id/assignments', async (req: any, res: any) => {
    try {
      new PermissionChecker(req).validateHas(Permissions.values.securityGuardEdit);
      const db = req.database;
      const uid = req.currentUser?.id;
      const pos = await db.supervisorPosition.findOne({ where: { id: req.params.id, tenantId: req.currentTenant.id } });
      if (!pos) throw new Error404();
      const data = pick(body(req), ASG_FIELDS);
      if (!data.startDate) data.startDate = new Date().toISOString().slice(0, 10);
      const created = await db.supervisorPositionAssignment.create({ ...data, positionId: pos.id, tenantId: req.currentTenant.id, createdById: uid, updatedById: uid });
      await regenerateForAssignment(db, req.currentTenant.id, created.id, uid).catch(() => undefined);
      const fresh = await db.supervisorPosition.findByPk(pos.id, { include: positionInclude(db) });
      await ApiResponseHandler.success(req, res, await shapePosition(db, fresh));
    } catch (error) { await ApiResponseHandler.error(req, res, error); }
  });

  // UNASSIGN
  app.delete('/tenant/:tenantId/supervisor-positions/:id/assignments/:assignmentId', async (req: any, res: any) => {
    try {
      new PermissionChecker(req).validateHas(Permissions.values.securityGuardEdit);
      const db = req.database;
      const asg = await db.supervisorPositionAssignment.findOne({ where: { id: req.params.assignmentId, positionId: req.params.id, tenantId: req.currentTenant.id } });
      if (!asg) throw new Error404();
      await asg.destroy();
      await db.supervisorScheduledShift.destroy({ where: { assignmentId: asg.id, tenantId: req.currentTenant.id } }).catch(() => undefined);
      const fresh = await db.supervisorPosition.findByPk(req.params.id, { include: positionInclude(db) });
      await ApiResponseHandler.success(req, res, await shapePosition(db, fresh));
    } catch (error) { await ApiResponseHandler.error(req, res, error); }
  });
};
