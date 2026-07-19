/**
 * Propagate an approved absence (time-off) into the LIVE schedule.
 *
 * Before this existed, approving a Time-Off request only flipped the row's
 * status: the Horario kept painting the guard D/N, coverage kept counting
 * them, and the worker app kept showing the turno. Now approval mirrors the
 * Programador novedad path: one scheduleOverride per day (upsert, same
 * semantics as scheduleOverrideCreate) + deletion of the guard's generated
 * shifts on those tenant-calendar days.
 */

const MAX_RANGE_DAYS = 366;

/** Map a time-off request type to a novedad code (V vacaciones · PM permiso). */
export function overrideTypeForTimeOff(requestType?: string | null): string {
  const t = String(requestType || '').toLowerCase();
  if (t.includes('vac')) return 'V';
  return 'PM';
}

export async function applyAbsenceOverrides(
  database: any,
  tenantId: string,
  guardUserId: string,
  startDateStr: string,
  endDateStr: string | null | undefined,
  type: string,
  createdById: string | null,
): Promise<{ days: number; shiftsRemoved: number }> {
  if (!guardUserId || !startDateStr) return { days: 0, shiftsRemoved: 0 };
  const { Op } = database.Sequelize;

  // Calendar-day walk over the DATEONLY strings (UTC-anchored — symmetric, so
  // no tz drift on the day labels themselves).
  const start = new Date(`${String(startDateStr).slice(0, 10)}T00:00:00Z`);
  const end = new Date(`${String(endDateStr || startDateStr).slice(0, 10)}T00:00:00Z`);
  if (isNaN(start.getTime()) || isNaN(end.getTime()) || end < start) return { days: 0, shiftsRemoved: 0 };
  const days: string[] = [];
  for (let t = start.getTime(); t <= end.getTime() && days.length < MAX_RANGE_DAYS; t += 86400000) {
    days.push(new Date(t).toISOString().slice(0, 10));
  }

  for (const date of days) {
    try {
      const [record, created] = await database.scheduleOverride.findOrCreate({
        where: { guardId: guardUserId, date, tenantId },
        defaults: { guardId: guardUserId, date, type, tenantId, createdById },
      });
      if (!created && record.type !== type) await record.update({ type });
    } catch (e: any) {
      console.warn('[scheduleAbsence] override upsert failed for', date, e?.message || e);
    }
  }

  // Remove the guard's generated shifts whose TENANT-calendar day falls in the
  // range (same tz attribution as scheduleOverrideCreate's propagation).
  let shiftsRemoved = 0;
  try {
    const tenant = await database.tenant.findByPk(tenantId, { attributes: ['timezone'] });
    const tz = (tenant && tenant.timezone) || 'UTC';
    const localDate = (d: any) => {
      try {
        return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(d));
      } catch {
        return new Date(d).toISOString().slice(0, 10);
      }
    };
    const from = new Date(start.getTime() - 24 * 3600000);
    const to = new Date(end.getTime() + 48 * 3600000);
    const shifts = await database.shift.findAll({
      where: { guardId: guardUserId, tenantId, startTime: { [Op.gte]: from, [Op.lt]: to } },
      attributes: ['id', 'startTime'],
    });
    const daySet = new Set(days);
    const toDelete = shifts.filter((s: any) => daySet.has(localDate(s.startTime))).map((s: any) => s.id);
    if (toDelete.length) {
      await database.shift.destroy({ where: { id: toDelete, tenantId }, force: true });
      shiftsRemoved = toDelete.length;
    }
  } catch (e: any) {
    console.warn('[scheduleAbsence] shift removal failed:', e?.message || e);
  }

  return { days: days.length, shiftsRemoved };
}
