/**
 * Feature #21 — Scheduled summary digest (best-effort).
 *
 * For each clientAccount with activity in the period, aggregate a site summary
 * (incidents, patrols completed, hours delivered, visits, on-duty changes) and
 * send the client BOTH:
 *   - a PUSH ("Resumen diario: N incidentes, N rondas…") via clientNotifyService
 *     (eventType 'digest.summary' → category 'digest', so per-client opt-out via
 *     Feature #23 is respected automatically inside notifyClient), AND
 *   - an email digest (branded via emailLayout + mailService) when the mail layer
 *     is configured and the client has an email on file.
 *
 * The aggregation reuses the raw-SQL style of api/customer/customerAnalytics.ts
 * (incidents/patrols by station.stationId, hours by guardShift.stationNameId),
 * filtered to each client's OWN stations (under their post-sites OR directly owned
 * via station.stationOriginId — same resolution as customerSafety/customerAnalytics).
 * One pass over each client's stations per run.
 *
 * Cadence is a single const (DIGEST_PERIOD_DAYS) so daily↔weekly is a one-line
 * change. Strictly best-effort: every client is independently try/caught and the
 * whole function never throws (runJob also guards it).
 */
import { notifyClient } from './clientNotifyService';

/** Period covered by each digest, in days. 1 = daily, 7 = weekly. */
export const DIGEST_PERIOD_DAYS = 1;

const periodLabel = () => (DIGEST_PERIOD_DAYS >= 7 ? 'semanal' : 'diario');

/** Resolve a clientAccount's station ids (post-site stations OR directly owned). */
async function resolveClientStationIds(db: any, tenantId: string, clientAccountId: string): Promise<string[]> {
  const { Op } = require('sequelize');
  const ids = new Set<string>();
  const [originStations, postSites] = await Promise.all([
    db.station.findAll({
      where: { tenantId, stationOriginId: clientAccountId, deletedAt: null },
      attributes: ['id'],
    }),
    db.businessInfo.findAll({
      where: { tenantId, clientAccountId, deletedAt: null },
      attributes: ['id'],
    }),
  ]);
  for (const s of originStations || []) ids.add(String(s.id));
  const postSiteIds = (postSites || []).map((b: any) => String(b.id));
  if (postSiteIds.length) {
    const psStations = await db.station.findAll({
      where: { tenantId, postSiteId: { [Op.in]: postSiteIds }, deletedAt: null },
      attributes: ['id'],
    });
    for (const s of psStations || []) ids.add(String(s.id));
  }
  return Array.from(ids);
}

interface DigestSummary {
  incidents: number;
  patrolsCompleted: number;
  hours: number;
  visits: number;
  onDutyChanges: number;
}

/** One pass of station-scoped aggregates for the period [start, end]. */
async function aggregateForStations(
  db: any,
  stationIds: string[],
  start: Date,
  end: Date,
): Promise<DigestSummary> {
  const sq = db.sequelize;
  const QT = sq.QueryTypes.SELECT;
  const R = { stationIds, start, end };
  const num = (v: any) => Number(v || 0);
  const q = async (sql: string): Promise<any[]> => {
    try { return (await sq.query(sql, { replacements: R, type: QT })) as any[]; }
    catch (e: any) { console.warn('[digest] query failed:', e?.message || e); return []; }
  };
  const one = async (sql: string) => (await q(sql))[0] || {};

  // incidents (incident.date — canonical event time, same as customerAnalytics)
  const inc = await one(
    `SELECT COUNT(*) c FROM incidents
     WHERE stationId IN (:stationIds) AND deletedAt IS NULL
       AND date >= :start AND date <= :end`,
  );
  // patrols completed (completed=1 OR status='Completed', by scheduledTime)
  const pat = await one(
    `SELECT SUM(CASE WHEN completed = 1 OR status = 'Completed' THEN 1 ELSE 0 END) completed
     FROM patrols
     WHERE stationId IN (:stationIds) AND deletedAt IS NULL
       AND scheduledTime >= :start AND scheduledTime <= :end`,
  );
  // hours delivered + on-duty changes (clock-ins) — guardShift.stationNameId
  const sh = await one(
    `SELECT
       COALESCE(SUM(
         CASE WHEN hoursWorked IS NOT NULL THEN hoursWorked
              ELSE TIMESTAMPDIFF(SECOND, punchInTime, COALESCE(punchOutTime, NOW())) / 3600
         END
       ), 0) hours,
       COUNT(*) onDutyChanges
     FROM guardShifts
     WHERE stationNameId IN (:stationIds) AND deletedAt IS NULL
       AND punchInTime >= :start AND punchInTime <= :end`,
  );
  // visits — visitorLog rows at the client's stations in the period
  const vis = await one(
    `SELECT COUNT(*) c FROM visitorLogs
     WHERE stationId IN (:stationIds) AND deletedAt IS NULL
       AND createdAt >= :start AND createdAt <= :end`,
  );

  return {
    incidents: num(inc.c),
    patrolsCompleted: num(pat.completed),
    hours: Math.round(num(sh.hours) * 10) / 10,
    visits: num(vis.c),
    onDutyChanges: num(sh.onDutyChanges),
  };
}

/** Lazily resolve the optional mail layer; returns null when not present. */
function loadMailLayer(): { sendMail: any; renderNotificationEmail: any } | null {
  try {
    const { sendMail } = require('./mailService');
    const { renderNotificationEmail } = require('../lib/emailLayout');
    if (typeof sendMail !== 'function') return null;
    return { sendMail, renderNotificationEmail };
  } catch {
    return null;
  }
}

/**
 * Run the digest for all tenants/clients. `db` is a databaseInit() handle.
 * Returns the number of clients notified (for logging).
 */
export async function runCustomerSummaryDigest(db: any): Promise<number> {
  let sent = 0;
  const end = new Date();
  const start = new Date(end.getTime() - DIGEST_PERIOD_DAYS * 86400000);

  const mail = loadMailLayer();
  let tenantNameById = new Map<string, string>();
  try {
    const tenants = await db.tenant.findAll({ attributes: ['id', 'name'] });
    tenantNameById = new Map((tenants || []).map((t: any) => [String(t.id), t.name || '']));
  } catch { /* non-fatal */ }

  let clients: any[] = [];
  try {
    clients = await db.clientAccount.findAll({
      where: { deletedAt: null },
      attributes: ['id', 'tenantId', 'name', 'lastName', 'email'],
    });
  } catch (e: any) {
    console.warn('[digest] clientAccount scan failed:', e?.message || e);
    return 0;
  }

  for (const c of clients || []) {
    const clientAccountId = String(c.id);
    const tenantId = String(c.tenantId || '');
    if (!tenantId) continue;
    try {
      const stationIds = await resolveClientStationIds(db, tenantId, clientAccountId);
      if (!stationIds.length) continue;

      const s = await aggregateForStations(db, stationIds, start, end);
      // Skip clients with NO activity in the period (no spam for quiet sites).
      const hasActivity =
        s.incidents > 0 || s.patrolsCompleted > 0 || s.hours > 0 || s.visits > 0 || s.onDutyChanges > 0;
      if (!hasActivity) continue;

      const label = periodLabel();
      const title = `Resumen ${label}`;
      const body =
        `Resumen ${label}: ${s.incidents} incidente(s), ${s.patrolsCompleted} ronda(s), ` +
        `${s.hours} h de servicio, ${s.visits} visita(s), ${s.onDutyChanges} cambio(s) de turno.`;

      // ── PUSH (digest category → respects Feature #23 opt-out inside notifyClient)
      const n = await notifyClient(
        db,
        tenantId,
        { clientAccountId },
        {
          eventType: 'digest.summary',
          title,
          body,
          data: {
            type: 'digest.summary',
            incidents: String(s.incidents),
            patrols: String(s.patrolsCompleted),
            hours: String(s.hours),
            visits: String(s.visits),
            onDutyChanges: String(s.onDutyChanges),
          },
          sourceEntityType: 'clientAccount',
          sourceEntityId: clientAccountId,
        },
      );
      if (n) sent += 1;

      // ── EMAIL digest (best-effort; only when mail layer + client email present) ─
      if (mail && c.email) {
        try {
          const tenantName = tenantNameById.get(tenantId) || '';
          const emailBody =
            `Este es tu resumen ${label} de seguridad:\n\n` +
            `• Incidentes: ${s.incidents}\n` +
            `• Rondas completadas: ${s.patrolsCompleted}\n` +
            `• Horas de servicio: ${s.hours}\n` +
            `• Visitas: ${s.visits}\n` +
            `• Cambios de turno (entradas): ${s.onDutyChanges}`;
          const html = mail.renderNotificationEmail({
            tenantName,
            eyebrow: 'Resumen de seguridad',
            title,
            body: emailBody,
          });
          await mail.sendMail({
            to: c.email,
            subject: `${tenantName ? tenantName + ' — ' : ''}${title} de seguridad`,
            html,
          });
        } catch (e: any) {
          console.warn('[digest] email send failed:', e?.message || e);
        }
      }
    } catch (e: any) {
      console.warn('[digest] client digest failed:', e?.message || e);
    }
  }

  if (sent) console.log(`[digest] sent ${sent} ${periodLabel()} digest(s)`);
  return sent;
}
