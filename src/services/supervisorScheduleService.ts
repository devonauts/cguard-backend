/**
 * Supervisor rotation engine — ISOLATED from the guard engine. Turns a puesto's
 * rotation (rotationStyle día/noche/rest) + an assignment's platoonOffset into
 * concrete dated supervisor shifts (supervisorScheduledShifts). Mirrors the guard
 * `shiftGenerationService` math but writes ONLY to supervisor tables — never
 * guardAssignment/shift/guardShift.
 */
import { Op } from 'sequelize';
import { wallClockToUtc } from '../lib/tenantTime';

const GENERATION_DAYS = 120; // rolling window of supervisor schedule
const ROTATION_EPOCH = new Date(2024, 0, 1); // fixed anchor so phase never drifts

/** día | noche | descanso for a given day, from the fixed epoch. */
function getRotationStatus(daysSinceEpoch: number, platoonOffset: number, dayShifts: number, nightShifts: number, restDays: number): 'day' | 'night' | 'rest' {
  const cycleLength = dayShifts + nightShifts + restDays;
  if (cycleLength <= 0) return 'rest';
  const adjustedDay = (((daysSinceEpoch - platoonOffset) % cycleLength) + cycleLength) % cycleLength;
  if (adjustedDay < dayShifts) return 'day';
  if (adjustedDay < dayShifts + nightShifts) return 'night';
  return 'rest';
}

async function tenantTz(db: any, tenantId: string): Promise<string> {
  try {
    const t = await db.tenant.findByPk(tenantId, { attributes: ['timezone'] });
    return (t && t.timezone) || 'UTC';
  } catch { return 'UTC'; }
}

/** día/noche by the block's start hour (18/6). A supervisor puesto is a single
 *  block, so its noche-ness lives in the hour, not the rotation counts. */
function halfByStart(hhmm?: string | null): 'day' | 'night' {
  const h = parseInt(String(hhmm || '').split(':')[0], 10);
  if (Number.isNaN(h)) return 'day';
  return h >= 18 || h < 6 ? 'night' : 'day';
}

/**
 * AUTHORITATIVE day-by-day schedule for a supervisor (the backend is the source
 * of truth; the app just paints this). Returns [{date, code}] where code is
 * 'D' | 'N' | 'L' | '' (unassigned), computed from the supervisor's ACTIVE puesto
 * assignment rotation — same math + tz as the generator, incl. rest days and days
 * the generator hasn't materialised. `tz` is returned alongside for the caller.
 */
export async function computeSupervisorDays(
  db: any, tenantId: string, userId: string, from: Date, to: Date,
): Promise<{ tz: string; days: { date: string; code: string }[] }> {
  const tz = await tenantTz(db, tenantId);
  const assignment = await db.supervisorPositionAssignment.findOne({
    where: { supervisorUserId: userId, tenantId, status: 'active' },
    order: [['createdAt', 'DESC']],
  });
  let position: any = null, rot: any = null;
  if (assignment) {
    position = await db.supervisorPosition.findOne({
      where: { id: assignment.positionId, tenantId },
      include: [{ model: db.rotationStyle, as: 'rotationStyle' }],
    });
    rot = position && position.rotationStyle;
  }

  const localYmd = (d: Date): string => {
    try { return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d); }
    catch { return d.toISOString().slice(0, 10); }
  };
  const dseOf = (y: number, m: number, d: number) => Math.round((Date.UTC(y, m - 1, d) - ROTATION_EPOCH.getTime()) / 86400000);
  const pad = (n: number) => String(n).padStart(2, '0');
  const sd = assignment && assignment.startDate ? String(assignment.startDate).slice(0, 10) : null;
  const ed = assignment && assignment.endDate ? String(assignment.endDate).slice(0, 10) : null;
  const dayStart = (position && position.startTime) || '07:00';
  const dayEnd = (position && position.endTime) || '19:00';
  const cycle = rot ? (rot.dayShifts || 0) + (rot.nightShifts || 0) + (rot.restDays || 0) : 0;

  const startYmd = localYmd(from);
  const endYmd = localYmd(to);
  const days: { date: string; code: string }[] = [];
  let cur = new Date(`${startYmd}T12:00:00Z`);
  const endCur = new Date(`${endYmd}T12:00:00Z`);
  let g = 0;
  while (cur <= endCur && g < 400) {
    g++;
    const y = cur.getUTCFullYear(), m = cur.getUTCMonth() + 1, d = cur.getUTCDate();
    const ds = `${y}-${pad(m)}-${pad(d)}`;
    let code = '';
    if (assignment && rot && cycle > 0) {
      if ((sd && ds < sd) || (ed && ds > ed)) code = '';
      else {
        const status = getRotationStatus(dseOf(y, m, d), assignment.platoonOffset || 0, rot.dayShifts, rot.nightShifts, rot.restDays);
        if (status === 'rest') code = 'L';
        else code = halfByStart(status === 'day' ? dayStart : dayEnd) === 'night' ? 'N' : 'D';
      }
    }
    days.push({ date: ds, code });
    cur = new Date(cur.getTime() + 86400000);
  }
  return { tz, days };
}

/** Compute the shift rows for one assignment (does not persist). */
function computeShifts(assignment: any, position: any, rotationStyle: any, tz: string): any[] {
  const dayShifts = rotationStyle.dayShifts ?? 0;
  const nightShifts = rotationStyle.nightShifts ?? 0;
  const restDays = rotationStyle.restDays ?? 0;
  if (dayShifts + nightShifts <= 0) return [];

  const dayStart = position.startTime || '07:00';
  const dayEnd = position.endTime || '19:00';
  const nightStart = dayEnd;
  const nightEnd = dayStart;

  const today = new Date();
  const start = assignment.startDate && new Date(assignment.startDate) > today ? new Date(assignment.startDate) : today;
  const genEnd = assignment.endDate
    ? new Date(assignment.endDate)
    : new Date(today.getTime() + GENERATION_DAYS * 86400000);

  const rows: any[] = [];
  const cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
  while (cursor <= genEnd) {
    const daysSinceEpoch = Math.floor((cursor.getTime() - ROTATION_EPOCH.getTime()) / 86400000);
    const status = getRotationStatus(daysSinceEpoch, assignment.platoonOffset || 0, dayShifts, nightShifts, restDays);
    if (status !== 'rest') {
      const dateStr = cursor.toISOString().slice(0, 10);
      let s: Date; let e: Date;
      if (status === 'day') { s = wallClockToUtc(dateStr, dayStart, tz); e = wallClockToUtc(dateStr, dayEnd, tz); }
      else { s = wallClockToUtc(dateStr, nightStart, tz); e = wallClockToUtc(dateStr, nightEnd, tz); }
      if (e <= s) e = new Date(e.getTime() + 86400000);
      rows.push({ startTime: s, endTime: e, shiftKind: status });
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return rows;
}

/** Regenerate future scheduled shifts for one assignment. */
export async function regenerateForAssignment(db: any, tenantId: string, assignmentId: string, actorId?: string) {
  const assignment = await db.supervisorPositionAssignment.findOne({ where: { id: assignmentId, tenantId } });
  if (!assignment || assignment.status !== 'active') {
    await db.supervisorScheduledShift.destroy({ where: { assignmentId, tenantId, startTime: { [Op.gte]: new Date() } } });
    return 0;
  }
  const position = await db.supervisorPosition.findOne({ where: { id: assignment.positionId, tenantId }, include: [{ model: db.rotationStyle, as: 'rotationStyle' }] });
  if (!position || !position.rotationStyle) return 0;
  const tz = await tenantTz(db, tenantId);

  // Clear the assignment's future plan, then rebuild.
  await db.supervisorScheduledShift.destroy({ where: { assignmentId, tenantId, startTime: { [Op.gte]: new Date() } } });

  const computed = computeShifts(assignment, position, position.rotationStyle, tz)
    .filter((r) => r.startTime >= new Date());
  if (!computed.length) return 0;

  const rows = computed.map((r) => ({
    supervisorUserId: assignment.supervisorUserId,
    positionId: assignment.positionId,
    assignmentId: assignment.id,
    startTime: r.startTime,
    endTime: r.endTime,
    shiftKind: r.shiftKind,
    tenantId,
    createdById: actorId || null,
    updatedById: actorId || null,
  }));
  await db.supervisorScheduledShift.bulkCreate(rows, { ignoreDuplicates: true });
  return rows.length;
}

/** Regenerate every active assignment of a position (after config change). */
export async function regenerateForPosition(db: any, tenantId: string, positionId: string, actorId?: string) {
  const assignments = await db.supervisorPositionAssignment.findAll({ where: { positionId, tenantId, status: 'active' } });
  let total = 0;
  for (const a of assignments) total += await regenerateForAssignment(db, tenantId, a.id, actorId);
  return total;
}

/** Upcoming generated shifts for one supervisor user. */
export async function upcomingForUser(db: any, tenantId: string, userId: string, count = 30) {
  const rows = await db.supervisorScheduledShift.findAll({
    where: { tenantId, supervisorUserId: userId, endTime: { [Op.gte]: new Date() } },
    include: [{ model: db.supervisorPosition, as: 'position', attributes: ['id', 'name', 'zone'] }],
    order: [['startTime', 'ASC']],
    limit: count,
  });
  return rows.map((r: any) => {
    const o = r.get({ plain: true });
    return {
      id: String(o.id),
      start: o.startTime,
      end: o.endTime,
      kind: o.shiftKind,
      position: o.position ? { id: String(o.position.id), name: o.position.name, zone: o.position.zone } : null,
    };
  });
}

/** The scheduled shift covering (or nearest around) an instant, for attendance. */
export async function scheduledShiftAt(db: any, tenantId: string, userId: string, instant: Date) {
  const windowStart = new Date(instant.getTime() - 12 * 3600000);
  const windowEnd = new Date(instant.getTime() + 12 * 3600000);
  const rows = await db.supervisorScheduledShift.findAll({
    where: { tenantId, supervisorUserId: userId, startTime: { [Op.between]: [windowStart, windowEnd] } },
    order: [['startTime', 'ASC']],
  });
  // Prefer a shift whose window contains the instant, else the nearest upcoming.
  let best: any = null;
  for (const r of rows) {
    if (instant >= r.startTime && instant <= r.endTime) return r;
    if (!best && r.startTime >= instant) best = r;
  }
  return best;
}
