/**
 * Notification fan-out for the client-task workflow. Reuses the existing channels:
 *   - worker app  → pushService.pushToUser (FCM)
 *   - client app  → clientNotifyService.notifyClient (APNs, supports image)
 *   - email + CRM → notificationDispatcher.dispatch (templates + preferences)
 */
import { dispatch } from '../lib/notificationDispatcher';
import { pushToUser } from './pushService';
import { notifyClient } from './clientNotifyService';

/** Active guard USER ids assigned to a station (the id pushToUser/device tokens key on). */
export async function stationGuardUserIds(db: any, tenantId: string, stationId: string): Promise<string[]> {
  if (!stationId) return [];
  try {
    const rows = await db.guardAssignment.findAll({
      where: { tenantId, stationId, status: 'active', deletedAt: null },
      attributes: ['guardId'],
    });
    return Array.from(new Set((rows || []).map((r: any) => String(r.guardId)).filter(Boolean)));
  } catch (e: any) {
    console.warn('[task] stationGuardUserIds failed:', e?.message || e);
    return [];
  }
}

async function stationMeta(db: any, stationId: string): Promise<{ name: string; postSiteId: string | null }> {
  try {
    const st = stationId ? await db.station.findByPk(stationId, { attributes: ['stationName', 'postSiteId'] }) : null;
    return { name: (st && st.stationName) || 'el puesto', postSiteId: (st && st.postSiteId) || null };
  } catch { return { name: 'el puesto', postSiteId: null }; }
}

async function clientEmail(db: any, clientAccountId?: string): Promise<string[]> {
  try {
    if (!clientAccountId) return [];
    const ca = await db.clientAccount.findByPk(clientAccountId, { attributes: ['email'] });
    const e = ca && ca.email ? String(ca.email).trim() : '';
    return e ? [e] : [];
  } catch { return []; }
}

function fmtDeadline(d: any): string {
  try { return d ? new Date(d).toLocaleString('es-EC') : ''; } catch { return ''; }
}

/** Client created a task → notify CRM supervisors (in-app + email). */
export async function notifyTaskPending(db: any, tenantId: string, task: any): Promise<void> {
  const { name, postSiteId } = await stationMeta(db, task.taskBelongsToStationId);
  await dispatch('task.pending_approval', { taskName: task.taskToDo, stationName: name, siteName: name }, {
    database: db, tenantId,
    sourceEntityType: 'task', sourceEntityId: String(task.id),
    assignedPostSiteId: postSiteId || undefined,
  }).catch((e: any) => console.warn('[task] pending dispatch failed:', e?.message || e));
}

/** Task approved → push all active station guards (worker app) + notify client + email. */
export async function notifyTaskApproved(db: any, tenantId: string, task: any): Promise<void> {
  const { name } = await stationMeta(db, task.taskBelongsToStationId);
  const deadline = fmtDeadline(task.dateToDoTheTask);

  const guardIds = await stationGuardUserIds(db, tenantId, task.taskBelongsToStationId);
  await Promise.all(guardIds.map((uid) =>
    pushToUser(db, tenantId, uid, {
      title: '📋 Nueva tarea',
      body: `${task.taskToDo}${name ? ` — ${name}` : ''}${deadline ? ` (antes de ${deadline})` : ''}`,
      data: {
        type: 'task.assigned',
        taskId: String(task.id),
        stationId: String(task.taskBelongsToStationId || ''),
        deadline: String(task.dateToDoTheTask || ''),
        priority: String(task.priority || 'media'),
      },
    }).catch(() => undefined),
  ));

  notifyClient(db, tenantId, { clientAccountId: task.clientAccountId, stationId: task.taskBelongsToStationId }, {
    eventType: 'task.approved',
    title: 'Tarea aprobada',
    body: `Tu tarea "${task.taskToDo}" fue aprobada para ${name}.`,
    data: { taskId: String(task.id), stationName: name, deadline: String(task.dateToDoTheTask || '') },
    sourceEntityType: 'task', sourceEntityId: String(task.id),
  }).catch(() => undefined);

  await dispatch('task.approved', { taskName: task.taskToDo, stationName: name, siteName: name, deadline }, {
    database: db, tenantId,
    sourceEntityType: 'task', sourceEntityId: String(task.id),
    extraEmails: await clientEmail(db, task.clientAccountId),
  }).catch((e: any) => console.warn('[task] approved dispatch failed:', e?.message || e));
}

/** Task rejected → notify the client (push + email). */
export async function notifyTaskRejected(db: any, tenantId: string, task: any, notes?: string): Promise<void> {
  const { name } = await stationMeta(db, task.taskBelongsToStationId);
  notifyClient(db, tenantId, { clientAccountId: task.clientAccountId, stationId: task.taskBelongsToStationId }, {
    eventType: 'task.rejected',
    title: 'Tarea rechazada',
    body: `Tu tarea "${task.taskToDo}" fue rechazada${notes ? `: ${notes}` : '.'}`,
    data: { taskId: String(task.id), notes: String(notes || '') },
    sourceEntityType: 'task', sourceEntityId: String(task.id),
  }).catch(() => undefined);

  await dispatch('task.rejected', { taskName: task.taskToDo, stationName: name, reason: notes || null }, {
    database: db, tenantId,
    sourceEntityType: 'task', sourceEntityId: String(task.id),
    extraEmails: await clientEmail(db, task.clientAccountId),
  }).catch((e: any) => console.warn('[task] rejected dispatch failed:', e?.message || e));
}

/** Task completed by a guard → notify the client (push w/ photo + email) and CRM. */
export async function notifyTaskCompleted(
  db: any, tenantId: string, task: any, opts: { guardName?: string; photoUrl?: string } = {},
): Promise<void> {
  const { name } = await stationMeta(db, task.taskBelongsToStationId);
  notifyClient(db, tenantId, { clientAccountId: task.clientAccountId, stationId: task.taskBelongsToStationId }, {
    eventType: 'task.completed',
    title: 'Tarea completada',
    body: `La tarea "${task.taskToDo}" fue completada en ${name}.`,
    image: opts.photoUrl || undefined,
    data: {
      taskId: String(task.id), stationName: name,
      guardName: String(opts.guardName || ''), photoUrl: String(opts.photoUrl || ''),
    },
    sourceEntityType: 'task', sourceEntityId: String(task.id),
  }).catch(() => undefined);

  await dispatch('task.completed', { taskName: task.taskToDo, guardName: opts.guardName || null, siteName: name, stationName: name }, {
    database: db, tenantId,
    sourceEntityType: 'task', sourceEntityId: String(task.id),
    extraEmails: await clientEmail(db, task.clientAccountId),
  }).catch((e: any) => console.warn('[task] completed dispatch failed:', e?.message || e));
}
