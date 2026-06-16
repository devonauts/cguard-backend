/**
 * Shift reminders — push notifications to the person assigned to a station turno
 * (guard or supervisor) ahead of their shift start, so they don't miss going
 * back to work after rest ("L") days.
 *
 * Reminder offsets before startTime: 2 days (heads-up while on rest), 1 day,
 * 12 hours, 1 hour, 10 minutes. Each fires once per shift per offset.
 *
 * Cluster-safe: the (shift, offset) is CLAIMED with a single atomic
 * JSON_ARRAY_APPEND guarded by JSON_CONTAINS — only the PM2 worker whose UPDATE
 * actually changes the row sends the push, so no duplicate notifications.
 *
 * Disable with SHIFT_REMINDERS_ENABLED=false.
 */
import { Op } from 'sequelize';
import { timeLabelInTz } from '../lib/tenantTime';
import { pushToUser } from './pushService';

interface Offset { key: string; ms: number; when: string }
const OFFSETS: Offset[] = [
  { key: '2d', ms: 48 * 3600 * 1000, when: 'en 2 días' },
  { key: '1d', ms: 24 * 3600 * 1000, when: 'mañana' },
  { key: '12h', ms: 12 * 3600 * 1000, when: 'en 12 horas' },
  { key: '1h', ms: 1 * 3600 * 1000, when: 'en 1 hora' },
  { key: '10m', ms: 10 * 60 * 1000, when: 'en 10 minutos' },
];
const MAX_LOOKAHEAD_MS = 49 * 3600 * 1000; // a hair over the largest offset

export async function runShiftReminders(db: any): Promise<void> {
  if (String(process.env.SHIFT_REMINDERS_ENABLED ?? 'true').toLowerCase() === 'false') return;

  const now = Date.now();
  const shifts = await db.shift.findAll({
    where: {
      startTime: { [Op.gt]: new Date(now), [Op.lte]: new Date(now + MAX_LOOKAHEAD_MS) },
    },
    include: [{ model: db.station, as: 'station', attributes: ['id', 'stationName'] }],
    order: [['startTime', 'ASC']],
    limit: 5000,
  });

  const tzCache: Record<string, string> = {};
  const tzFor = async (tenantId: string): Promise<string> => {
    if (tzCache[tenantId] !== undefined) return tzCache[tenantId];
    const t = await db.tenant.findByPk(tenantId, { attributes: ['timezone'] });
    return (tzCache[tenantId] = (t && t.timezone) || 'UTC');
  };

  let sent = 0;
  for (const sh of shifts) {
    const s = sh.get({ plain: true });
    if (!s.guardId) continue;
    const start = new Date(s.startTime).getTime();

    for (const off of OFFSETS) {
      const remindAt = start - off.ms;
      if (now < remindAt || now >= start) continue; // not due yet, or already started

      // Atomic, cluster-safe claim. Only one worker's UPDATE matches.
      let claimed = false;
      try {
        const [res]: any = await db.sequelize.query(
          "UPDATE shifts SET remindersSent = JSON_ARRAY_APPEND(COALESCE(remindersSent, JSON_ARRAY()), '$', :key) " +
            "WHERE id = :id AND (remindersSent IS NULL OR JSON_CONTAINS(remindersSent, JSON_QUOTE(:key)) = 0)",
          { replacements: { key: off.key, id: s.id } },
        );
        claimed = !!(res && (res.affectedRows ?? res.rowCount) > 0);
      } catch {
        claimed = false;
      }
      if (!claimed) continue;

      try {
        const tz = await tzFor(s.tenantId);
        const stationName = (s.station && s.station.stationName) || 'tu puesto';
        const title = 'Recordatorio de turno';
        const body = `Tu turno en ${stationName} empieza ${off.when} (${timeLabelInTz(s.startTime, tz)}). No olvides marcar tu entrada.`;
        await pushToUser(db, s.tenantId, s.guardId, {
          title,
          body,
          data: {
            type: 'shift.reminder',
            shiftId: String(s.id),
            stationId: String(s.stationId || ''),
            offset: off.key,
            startTime: new Date(s.startTime).toISOString(),
          },
        });
        sent++;
      } catch {
        /* best-effort; the claim already marked it sent to avoid ret-spam */
      }
    }
  }

  if (sent) console.log(`[shiftReminders] sent ${sent} reminder(s)`);
}
