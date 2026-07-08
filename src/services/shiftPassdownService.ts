/**
 * Shift passdown (pase de turno / relevo) service.
 *
 * Outgoing guard leaves a handover at clock-out (general novedades + photos + discrete
 * instructions). Each instruction becomes an approved task (source='passdown') for the
 * post, so it appears instantly for whoever clocks in next. The next guard "receives"
 * the passdown automatically on clock-in. The CRM (+ client/supervisor) can read all of
 * them. Best-effort throughout — a passdown failure never blocks clock-out.
 */
import FileRepository from '../database/repositories/fileRepository';
import { storePlatformEvent } from '../lib/platformEventStore';

const DISPATCHER_TARGET_ROLES = 'admin,operationsManager,securitySupervisor,dispatcher';
// How far back a clock-in looks for an unreceived handover at the post.
const RELIEF_WINDOW_HOURS = 12;

/** Classify the shift length from its scheduled window: 24h vs 12h vs otro. */
export function deriveShiftKind(start?: Date | string | null, end?: Date | string | null): string {
  if (!start || !end) return 'otro';
  const hrs = (new Date(end).getTime() - new Date(start).getTime()) / 3.6e6;
  if (!isFinite(hrs) || hrs <= 0) return 'otro';
  if (hrs >= 20) return '24h';
  if (hrs >= 10 && hrs < 16) return '12h';
  return 'otro';
}

/** A human label like "Turno nocturno · 12h" for UI. */
export function passdownShiftLabel(shiftSchedule?: string | null, shiftKind?: string | null): string {
  const sched = shiftSchedule === 'Nocturno' ? 'Turno nocturno' : shiftSchedule === 'Diurno' ? 'Turno diurno' : 'Turno';
  const kind = shiftKind === '24h' ? '24 horas' : shiftKind === '12h' ? '12 horas' : '';
  return kind ? `${sched} · ${kind}` : sched;
}

export async function createPassdown(
  db: any,
  tenantId: string,
  opts: {
    station?: { id?: string | null; stationName?: string | null; postSiteId?: string | null } | null;
    channel?: 'guard' | 'supervisor';
    guardShift?: any;
    outgoingUserId?: string | null;
    outgoingSecurityGuardId?: string | null;
    outgoingGuardName?: string | null;
    shiftSchedule?: string | null;
    notes?: string | null;
    instructions?: Array<{ text: string; priority?: string }>;
    photos?: any[];
    currentUser?: any;
  },
): Promise<any> {
  const channel = opts.channel === 'supervisor' ? 'supervisor' : 'guard';
  const isSupervisor = channel === 'supervisor';
  const stationId = opts.station?.id || null;
  const instructions = (opts.instructions || []).filter(
    (i) => i && typeof i.text === 'string' && i.text.trim(),
  );
  const shiftSchedule = opts.shiftSchedule || opts.guardShift?.shiftSchedule || null;
  const shiftKind = deriveShiftKind(opts.guardShift?.scheduledStart, opts.guardShift?.scheduledEnd);
  const notes = typeof opts.notes === 'string' && opts.notes.trim() ? opts.notes.trim().slice(0, 4000) : null;

  const passdown = await db.shiftPassdown.create({
    tenantId,
    channel,
    stationId,
    stationName: opts.station?.stationName || null,
    postSiteId: opts.station?.postSiteId || null,
    outgoingGuardUserId: opts.outgoingUserId || null,
    outgoingSecurityGuardId: opts.outgoingSecurityGuardId || null,
    outgoingGuardName: opts.outgoingGuardName || null,
    guardShiftId: opts.guardShift?.id || null,
    shiftSchedule,
    shiftKind,
    notes,
    instructionCount: instructions.length,
    // Supervisors aren't station-bound, so their instructions can't become
    // post-tasks — persist them inline instead (hydrated back the same shape).
    instructionsJson: isSupervisor && instructions.length
      ? JSON.stringify(instructions.map((i) => ({
          taskToDo: i.text.trim().slice(0, 300),
          priority: ['alta', 'media', 'baja'].includes(String(i.priority)) ? i.priority : 'media',
          wasItDone: false,
        })))
      : null,
    status: 'open',
  });

  // Photos → passdownImages relation (best-effort).
  if (Array.isArray(opts.photos) && opts.photos.length) {
    try {
      await FileRepository.replaceRelationFiles(
        { belongsTo: db.shiftPassdown.getTableName(), belongsToColumn: 'passdownImages', belongsToId: passdown.id },
        opts.photos,
        { database: db, currentUser: opts.currentUser, currentTenant: { id: tenantId } } as any,
      );
    } catch (e: any) {
      console.warn('[passdown] photo attach failed:', e?.message || e);
    }
  }

  // Each instruction → an approved task for the post → appears for the incoming guard
  // (GET /guard/me/tasks) and in the CRM task tracking (source='passdown'). Only
  // for station-bound (guard) passdowns; supervisor instructions live in
  // instructionsJson (above) since they have no post.
  const dueDate = new Date();
  if (!isSupervisor && stationId) {
    for (const ins of instructions) {
      try {
        await db.task.create({
          tenantId,
          taskToDo: ins.text.trim().slice(0, 300),
          taskBelongsToStationId: stationId,
          dateToDoTheTask: dueDate,
          status: 'approved',
          source: 'passdown',
          priority: ['alta', 'media', 'baja'].includes(String(ins.priority)) ? ins.priority : 'media',
          wasItDone: false,
          passdownId: passdown.id,
          createdById: opts.outgoingUserId || null,
          approvedAt: dueDate,
        });
      } catch (e: any) {
        console.warn('[passdown] instruction task failed:', e?.message || e);
      }
    }
  }

  // CRM / supervisor awareness.
  try {
    await storePlatformEvent(db, {
      tenantId,
      eventType: 'passdown.created',
      title: isSupervisor
        ? `Pase de turno — Supervisión${opts.outgoingGuardName ? ` (${opts.outgoingGuardName})` : ''}`
        : `Pase de turno — ${opts.station?.stationName || 'Puesto'}`,
      body: notes ? notes.slice(0, 140) : instructions.length ? `${instructions.length} instrucción(es)` : 'Sin novedad',
      targetRoles: DISPATCHER_TARGET_ROLES,
      sourceEntityType: 'shiftPassdown',
      sourceEntityId: passdown.id,
      payload: { passdownId: passdown.id, channel, stationId, stationName: opts.station?.stationName || null, instructionCount: instructions.length },
    } as any);
  } catch (e) { /* best-effort */ }

  return passdown;
}

/**
 * The latest UNRECEIVED passdown left at any of the given stations (not by this guard),
 * within the relief window. Optionally marks it received (on clock-in).
 */
export async function getIncomingForGuard(
  db: any,
  tenantId: string,
  userId: string,
  opts: { stationIds?: string[]; channel?: 'guard' | 'supervisor'; markReceived?: boolean; receivedByName?: string | null; receivedByShiftId?: string | null },
): Promise<any | null> {
  const { Op } = db.Sequelize;
  const channel = opts.channel === 'supervisor' ? 'supervisor' : 'guard';
  const since = new Date(Date.now() - RELIEF_WINDOW_HOURS * 3.6e6);
  const where: any = {
    tenantId,
    deletedAt: null,
    status: 'open',
    channel,
    outgoingGuardUserId: { [Op.ne]: userId },
    createdAt: { [Op.gte]: since },
  };
  if (channel === 'supervisor') {
    // Supervisors hand over tenant-wide (roaming, no fixed post): the next
    // supervisor to clock in receives the most recent open supervisor handover.
  } else {
    // Guards are matched to the post they clocked into.
    const stationIds = (opts.stationIds || []).filter(Boolean);
    if (!stationIds.length) return null;
    where.stationId = { [Op.in]: stationIds };
  }
  const passdown = await db.shiftPassdown.findOne({
    where,
    order: [['createdAt', 'DESC']],
  });
  if (!passdown) return null;
  if (opts.markReceived) {
    try {
      await passdown.update({
        status: 'received',
        receivedByGuardUserId: userId,
        receivedByName: opts.receivedByName || null,
        receivedByShiftId: opts.receivedByShiftId || null,
        receivedAt: new Date(),
      });
    } catch (e) { /* non-fatal */ }
  }
  return hydratePassdown(db, passdown);
}

/** Full detail: passdown + signed photos + its instruction tasks (with completion). */
export async function findPassdownById(db: any, tenantId: string, id: string): Promise<any | null> {
  const passdown = await db.shiftPassdown.findOne({ where: { id, tenantId, deletedAt: null } });
  if (!passdown) return null;
  return hydratePassdown(db, passdown, true);
}

/** CRM / supervisor list, newest first, filterable by station + status. */
export async function listPassdowns(
  db: any,
  tenantId: string,
  filter: { stationId?: string; status?: string; limit?: number; offset?: number } = {},
): Promise<{ rows: any[]; count: number }> {
  const where: any = { tenantId, deletedAt: null };
  if (filter.stationId) where.stationId = filter.stationId;
  if (filter.status && filter.status !== 'all') where.status = filter.status;
  const { rows, count } = await db.shiftPassdown.findAndCountAll({
    where,
    order: [['createdAt', 'DESC']],
    limit: filter.limit ? Number(filter.limit) : 100,
    offset: filter.offset ? Number(filter.offset) : 0,
  });
  const out: any[] = [];
  for (const r of rows) out.push(await hydratePassdown(db, r, false));
  return { rows: out, count };
}

/** Attach signed photos + (optionally) the instruction tasks to a passdown row. */
async function hydratePassdown(db: any, passdown: any, withInstructions = true): Promise<any> {
  const plain = passdown.get ? passdown.get({ plain: true }) : passdown;
  try {
    const files = await db.file.findAll({
      where: { belongsTo: db.shiftPassdown.getTableName(), belongsToColumn: 'passdownImages', belongsToId: plain.id },
    });
    plain.passdownImages = await FileRepository.fillDownloadUrl(files);
  } catch (e) {
    plain.passdownImages = [];
  }
  if (withInstructions) {
    if (plain.channel === 'supervisor') {
      // Supervisor instructions live inline (no post-tasks).
      try {
        plain.instructions = plain.instructionsJson ? JSON.parse(plain.instructionsJson) : [];
      } catch (e) {
        plain.instructions = [];
      }
    } else {
      try {
        const tasks = await db.task.findAll({
          where: { tenantId: plain.tenantId, passdownId: plain.id, deletedAt: null },
          attributes: ['id', 'taskToDo', 'priority', 'status', 'wasItDone', 'dateCompletedTask', 'completionNotes'],
          order: [['createdAt', 'ASC']],
        });
        plain.instructions = tasks.map((t: any) => t.get({ plain: true }));
      } catch (e) {
        plain.instructions = [];
      }
    }
    delete plain.instructionsJson;
  }
  plain.shiftLabel = passdownShiftLabel(plain.shiftSchedule, plain.shiftKind);
  return plain;
}
