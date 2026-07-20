/**
 * Scheduled-reports runner. Reads active `reportSchedule` rows whose nextRunAt is
 * due, generates the client report CSV (via the shared generateClientReport), emails
 * it to the schedule's creator + the client account, and advances nextRunAt.
 *
 * Previously reportSchedule rows were saved and shown as "programado" in the UI but
 * NOTHING executed them — a silent no-op. This makes them real.
 *
 * Called once per minute from server.ts under the cluster leader lock. Each due row
 * is claimed with an atomic UPDATE (WHERE still-due) so an overlapping tick or a
 * leader hand-off can't double-send.
 */
import { Op } from 'sequelize';
import { generateClientReport } from './clientReportGenerator';
import { sendMail } from './mailService';

/** Next fire time for a frequency, matching the cron strings used on create. */
export function computeScheduleNextRun(frequency: string, from: Date = new Date()): Date {
  const f = String(frequency || 'weekly');
  const d = new Date(from.getTime());

  if (f === 'daily') {
    const next = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 7, 0, 0, 0); // 07:00
    if (next <= d) next.setDate(next.getDate() + 1);
    return next;
  }

  if (f === 'monthly') {
    const thisMonth = new Date(d.getFullYear(), d.getMonth(), 1, 9, 0, 0, 0); // 1st @ 09:00
    if (thisMonth > d) return thisMonth;
    return new Date(d.getFullYear(), d.getMonth() + 1, 1, 9, 0, 0, 0);
  }

  // weekly → next Monday 08:00
  const next = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 8, 0, 0, 0);
  const daysUntilMonday = (1 - next.getDay() + 7) % 7; // 0=Sun … 1=Mon
  next.setDate(next.getDate() + daysUntilMonday);
  if (next <= d) next.setDate(next.getDate() + 7);
  return next;
}

/** Rolling data window a given frequency's report should cover. */
function windowFor(frequency: string, now: Date): { from: Date; to: Date } {
  const to = new Date(now.getTime());
  const from = new Date(now.getTime());
  if (frequency === 'daily') from.setDate(from.getDate() - 1);
  else if (frequency === 'monthly') from.setDate(from.getDate() - 30);
  else from.setDate(from.getDate() - 7);
  return { from, to };
}

async function resolveRecipients(db: any, sched: any, params: any): Promise<string[]> {
  const emails = new Set<string>();
  try {
    if (sched.createdById && db.user) {
      const u = await db.user.findByPk(sched.createdById);
      const e = u && (u.email || u.emailAddress);
      if (e) emails.add(String(e).trim());
    }
  } catch { /* ignore */ }
  try {
    if (params.clientId && db.clientAccount) {
      const c = await db.clientAccount.findByPk(params.clientId);
      const e = c && (c.email || c.contactEmail);
      if (e) emails.add(String(e).trim());
    }
  } catch { /* ignore */ }
  return [...emails].filter((e) => /.+@.+\..+/.test(e));
}

export async function runDueReportSchedules(db: any): Promise<void> {
  if (!db || !db.reportSchedule) return;
  const now = new Date();

  const due = await db.reportSchedule.findAll({
    where: { active: true, [Op.or]: [{ nextRunAt: null }, { nextRunAt: { [Op.lte]: now } }] },
    limit: 100,
  });

  for (const sched of due) {
    const params = (sched.params || {}) as any;
    const frequency = String(params.frequency || 'weekly');
    const next = computeScheduleNextRun(frequency, now);

    // Atomic claim: only proceed if THIS worker's update flips a still-due row.
    const [claimed] = await db.reportSchedule.update(
      { nextRunAt: next, lastRunAt: now },
      { where: { id: sched.id, active: true, [Op.or]: [{ nextRunAt: null }, { nextRunAt: { [Op.lte]: now } }] } },
    );
    if (!claimed) continue;

    try {
      if (!params.clientId || !sched.tenantId) continue;
      const { from, to } = windowFor(frequency, now);
      const result = await generateClientReport(db, {
        tenantId: String(sched.tenantId),
        clientAccountId: String(params.clientId),
        type: String(params.type || 'incidents'),
        from,
        to,
      });

      const recipients = await resolveRecipients(db, sched, params);
      if (!recipients.length) {
        console.warn('[ScheduledReports] no recipients for schedule', sched.id);
        continue;
      }

      const periodLabel = `${from.toISOString().slice(0, 10)} → ${to.toISOString().slice(0, 10)}`;
      await sendMail({
        to: recipients,
        subject: `${sched.name || 'Reporte programado'} (${periodLabel})`,
        html: `<p>Adjunto el reporte programado <strong>${(sched.name || 'Reporte')}</strong>.</p>`
          + `<p>Período: ${periodLabel}<br/>Registros: ${result.rowCount}</p>`,
        attachments: [{ filename: result.filename, content: '﻿' + result.csv }],
      });
      console.info('[ScheduledReports] sent', { id: sched.id, to: recipients.length, rows: result.rowCount });
    } catch (e: any) {
      console.error('[ScheduledReports] run failed for schedule', sched.id, e && e.message ? e.message : e);
    }
  }
}

export default runDueReportSchedules;
