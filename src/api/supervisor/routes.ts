import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import Error400 from '../../errors/Error400';
import Error404 from '../../errors/Error404';
import { dispatch } from '../../lib/notificationDispatcher';
import { notifyClient } from '../../services/clientNotifyService';
import {
  todayDateStr,
  routeRunsToday,
  resolveStopSafe,
  normalizeTasks,
  fileOptionsFor,
} from './helpers';

/** Load the ordered points of a route. */
async function loadPoints(db: any, routeId: string) {
  return db.routePoint.findAll({ where: { routeId }, order: [['order', 'ASC']] });
}

/** Today's run for a route (or null). */
async function findTodayRun(db: any, tenantId: string, routeId: string, date: string) {
  return db.routeRun.findOne({ where: { tenantId, routeId, date } });
}

/** Map of routePointId -> visit for a given run. */
async function visitsByPoint(db: any, tenantId: string, runId: string | null) {
  const map: Record<string, any> = {};
  if (!runId || !db.routePointVisit) return map;
  const visits = await db.routePointVisit.findAll({ where: { tenantId, runId } });
  for (const v of visits) {
    const plain = v.get ? v.get({ plain: true }) : v;
    if (plain.routePointId) map[plain.routePointId] = plain;
  }
  return map;
}

/** Serialize one route + its points/visits into the contract shape. */
async function serializeRoute(req: any, route: any, date: string) {
  const db = req.database;
  const tenantId = req.currentTenant.id;
  const points = await loadPoints(db, route.id);
  const run = await findTodayRun(db, tenantId, route.id, date);
  const runId = run ? run.id : null;
  const visitMap = await visitsByPoint(db, tenantId, runId);

  const serializedPoints = await Promise.all(
    points.map(async (p: any) => {
      const plain = p.get ? p.get({ plain: true }) : p;
      const resolved = await resolveStopSafe(db, tenantId, plain);
      const visit = visitMap[plain.id] || null;
      return {
        id: plain.id,
        order: plain.order,
        siteType: resolved.siteType ?? plain.siteType ?? null,
        name: resolved.name,
        address: resolved.address,
        lat: resolved.lat,
        lng: resolved.lng,
        duration: plain.duration ?? null,
        scheduledHits: plain.scheduledHits ?? null,
        tasks: normalizeTasks({ tasks: resolved.tasks ?? plain.tasks }),
        visit: visit
          ? { status: visit.status, completedAt: visit.completedAt }
          : null,
      };
    }),
  );

  return {
    route: { id: route.id, name: route.name },
    run: run ? { id: run.id, status: run.status } : null,
    points: serializedPoints,
  };
}

/** Load the current supervisor's routes scheduled for today. */
async function myRoutesToday(req: any) {
  const db = req.database;
  const tenantId = req.currentTenant.id;
  const all = await db.route.findAll({
    where: { tenantId, assignedGuard: req.currentUser.id },
    order: [['name', 'ASC']],
  });
  return all.filter((r: any) => routeRunsToday(r));
}

/** GET /supervisor/me/routes/today */
export const getRoutesToday = async (req: any, res: any) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.supervisorMe);
    const date = todayDateStr();
    const routes = await myRoutesToday(req);
    const serialized = await Promise.all(routes.map((r: any) => serializeRoute(req, r, date)));
    await ApiResponseHandler.success(req, res, { routes: serialized });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};

/** GET /supervisor/me/routes/:routeId */
export const getRouteDetail = async (req: any, res: any) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.supervisorMe);
    const db = req.database;
    const tenantId = req.currentTenant.id;
    const route = await db.route.findOne({
      where: { id: req.params.routeId, tenantId, assignedGuard: req.currentUser.id },
    });
    if (!route) throw new Error404();
    const serialized = await serializeRoute(req, route, todayDateStr());
    await ApiResponseHandler.success(req, res, serialized);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};

/** Load a route owned by the current supervisor or 404. */
async function myRouteOr404(req: any) {
  const db = req.database;
  const route = await db.route.findOne({
    where: {
      id: req.params.routeId,
      tenantId: req.currentTenant.id,
      assignedGuard: req.currentUser.id,
    },
  });
  if (!route) throw new Error404();
  return route;
}

/** Upsert today's run for a route. */
async function upsertRun(req: any, route: any, patch: any) {
  const db = req.database;
  const tenantId = req.currentTenant.id;
  const date = todayDateStr();
  let run = await findTodayRun(db, tenantId, route.id, date);
  const base = {
    completedByName: req.currentUser.fullName || req.currentUser.email || null,
    completedById: req.currentUser.id,
    ...patch,
  };
  if (run) await run.update(base);
  else run = await db.routeRun.create({ ...base, tenantId, routeId: route.id, date });
  return run;
}

/** POST /supervisor/me/routes/:routeId/start */
export const startRoute = async (req: any, res: any) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.supervisorMe);
    const db = req.database;
    const tenantId = req.currentTenant.id;
    const route = await myRouteOr404(req);
    const run = await upsertRun(req, route, { status: 'in_progress', completedAt: null });

    const points = await loadPoints(db, route.id);
    dispatch(
      'supervisor.route.started',
      {
        supervisorName: req.currentUser.fullName || req.currentUser.email || 'Supervisor',
        routeName: route.name,
        pointsCount: points.length,
      },
      {
        database: db,
        tenantId,
        sourceEntityType: 'routeRun',
        sourceEntityId: run.id,
      },
    ).catch((e) => console.warn('[supervisor.startRoute] dispatch failed:', e?.message || e));

    await ApiResponseHandler.success(req, res, {
      run: { id: run.id, status: run.status },
    });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};

/**
 * POST /supervisor/me/routes/:routeId/stops/:pointId/check
 * { taskResults, notes, photoIds, latitude, longitude }
 */
export const checkStop = async (req: any, res: any) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.supervisorMe);
    const db = req.database;
    const tenantId = req.currentTenant.id;
    const data = (req.body && req.body.data) || req.body || {};
    const route = await myRouteOr404(req);

    const point = await db.routePoint.findOne({
      where: { id: req.params.pointId, routeId: route.id },
    });
    if (!point) throw new Error404();

    // Ensure today's run exists (mark in-progress if it wasn't started yet).
    const run = await upsertRun(req, route, { status: 'in_progress' });

    if (!db.routePointVisit) throw new Error400(req.language);

    const visitPayload: any = {
      status: 'completed',
      completedAt: new Date(),
      taskResults: data.taskResults ?? null,
      notes: data.notes ?? null,
      latitude: data.latitude ?? null,
      longitude: data.longitude ?? null,
      completedById: req.currentUser.id,
    };

    let visit = await db.routePointVisit.findOne({
      where: { tenantId, runId: run.id, routePointId: point.id },
    });
    if (visit) {
      await visit.update(visitPayload);
    } else {
      visit = await db.routePointVisit.create({
        ...visitPayload,
        tenantId,
        runId: run.id,
        routeId: route.id,
        routePointId: point.id,
      });
    }

    // Attach proof photos (uploaded via the credentials flow, posted back as
    // stored file descriptors). Accept photoIds or proofImages. Best-effort.
    const photos = data.photoIds ?? data.proofImages;
    if (photos !== undefined) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const FileRepository = require('../../database/repositories/fileRepository').default;
        await FileRepository.replaceRelationFiles(
          {
            belongsTo: db.routePointVisit.getTableName(),
            belongsToColumn: 'proofImages',
            belongsToId: visit.id,
          },
          Array.isArray(photos) ? photos : [photos],
          fileOptionsFor(req),
        );
      } catch (e: any) {
        console.warn('[supervisor.checkStop] proof link failed:', e?.message || e);
      }
    }

    const resolved = await resolveStopSafe(db, tenantId, point.get ? point.get({ plain: true }) : point);
    dispatch(
      'supervisor.stop.completed',
      {
        supervisorName: req.currentUser.fullName || req.currentUser.email || 'Supervisor',
        routeName: route.name,
        stopName: resolved.name,
      },
      {
        database: db,
        tenantId,
        sourceEntityType: 'routePointVisit',
        sourceEntityId: visit.id,
      },
    ).catch((e) => console.warn('[supervisor.checkStop] dispatch failed:', e?.message || e));

    await ApiResponseHandler.success(req, res, {
      visit: { status: visit.status, completedAt: visit.completedAt },
    });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};

/** POST /supervisor/me/routes/:routeId/finish { note? } */
export const finishRoute = async (req: any, res: any) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.supervisorMe);
    const db = req.database;
    const tenantId = req.currentTenant.id;
    const data = (req.body && req.body.data) || req.body || {};
    const route = await myRouteOr404(req);

    const run = await upsertRun(req, route, {
      status: 'completed',
      completedAt: new Date(),
      note: data.note ?? null,
    });

    const points = await loadPoints(db, route.id);
    const completedCount = db.routePointVisit
      ? await db.routePointVisit.count({ where: { tenantId, runId: run.id, status: 'completed' } })
      : 0;

    dispatch(
      'supervisor.route.finished',
      {
        supervisorName: req.currentUser.fullName || req.currentUser.email || 'Supervisor',
        routeName: route.name,
        completedCount,
        pointsCount: points.length,
      },
      {
        database: db,
        tenantId,
        sourceEntityType: 'routeRun',
        sourceEntityId: run.id,
      },
    ).catch((e) => console.warn('[supervisor.finishRoute] dispatch failed:', e?.message || e));

    await ApiResponseHandler.success(req, res, {
      run: { id: run.id, status: run.status },
    });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};

/**
 * Notify the CRM and the station's client that the supervisor is en route to a
 * stop, with an ETA. The client (Mi Seguridad app) gets a push via
 * notifyClient; the CRM gets a realtime + stored platform event. Best-effort —
 * a delivery failure never fails the request.
 *
 * POST /supervisor/me/routes/:routeId/stops/:pointId/notify-eta   body: { etaMinutes }
 */
export const notifyStopEta = async (req: any, res: any) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.supervisorMe);
    const db = req.database;
    const tenantId = req.currentTenant.id;
    const data = (req.body && req.body.data) || req.body || {};
    const etaMinutes = Math.max(1, Math.min(240, Math.round(Number(data.etaMinutes) || 15)));

    const route = await db.route.findOne({ where: { id: req.params.routeId, tenantId } });
    if (!route) throw new Error404();
    const point = await db.routePoint.findOne({ where: { id: req.params.pointId, routeId: route.id } });
    if (!point) throw new Error404();
    const plain = point.get ? point.get({ plain: true }) : point;
    const resolved = await resolveStopSafe(db, tenantId, plain);
    const stopName = resolved.name || 'la estación';
    const supName = req.currentUser?.fullName || req.currentUser?.email || 'El supervisor';
    const etaAt = new Date(Date.now() + etaMinutes * 60000);

    const title = 'Supervisor en camino';
    const body = `${supName} va en camino a ${stopName}. Llegada estimada en ${etaMinutes} min.`;
    const payload = {
      routeId: String(route.id),
      pointId: String(plain.id),
      stopName,
      etaMinutes: String(etaMinutes),
      etaAt: etaAt.toISOString(),
    };

    // Client app (Mi Seguridad) — only for station/client stops that resolve to a client.
    let clientNotified = false;
    try {
      const siteType = plain.siteType || 'station';
      if (plain.siteId && (siteType === 'station' || siteType === 'client')) {
        const ref = siteType === 'client' ? { clientAccountId: plain.siteId } : { stationId: plain.siteId };
        const r = await notifyClient(db, tenantId, ref as any, {
          eventType: 'supervisor.eta',
          title,
          body,
          category: 'supervisor',
          sourceEntityType: 'route',
          sourceEntityId: String(route.id),
          data: payload,
        });
        clientNotified = Boolean(r);
      }
    } catch (e: any) {
      console.warn('[supervisor.notifyStopEta] client notify failed:', e?.message || e);
    }

    // CRM realtime + stored notification.
    try {
      const { storePlatformEvent } = require('../../lib/platformEventStore');
      await storePlatformEvent(db, {
        tenantId,
        eventType: 'supervisor.route.eta',
        title,
        body,
        targetRoles: 'admin,operationsManager',
        sourceEntityType: 'route',
        sourceEntityId: String(route.id),
        payload,
      });
    } catch (e: any) {
      console.warn('[supervisor.notifyStopEta] CRM event failed:', e?.message || e);
    }

    await ApiResponseHandler.success(req, res, { ok: true, etaAt: etaAt.toISOString(), stopName, clientNotified });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
