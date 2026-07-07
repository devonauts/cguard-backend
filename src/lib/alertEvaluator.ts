/**
 * alertEvaluator — evaluates the per-minute metrics snapshot against thresholds
 * and fires ONE superadmin notification per breach (with a cooldown so a
 * sustained condition doesn't spam). This is the platform's first "tell me
 * before users do" path: disk-full on /uploads, RAM/heap exhaustion, DB pool
 * saturation, error spikes, and failed jobs. Runs on the leader inside the
 * MetricsSnapshot job. Notifications land in the existing superadmin bell/center.
 *
 * Thresholds are env-overridable so they can be tuned without a deploy.
 */
import { createNotification } from '../services/superadmin/superadminNotificationService';

const num = (v: string | undefined, d: number) => (v && !isNaN(Number(v)) ? Number(v) : d);

export const THRESHOLDS = {
  diskPct: num(process.env.ALERT_DISK_PCT, 90),
  hostMemPct: num(process.env.ALERT_MEM_PCT, 92),
  heapUsedPct: num(process.env.ALERT_HEAP_PCT, 92),
  loadPct: num(process.env.ALERT_LOAD_PCT, 400),
  errorSpike: num(process.env.ALERT_ERROR_SPIKE, 20), // errors/minute
  poolWaiting: 0, // any waiting connection = saturation
};

const COOLDOWN_MS = num(process.env.ALERT_COOLDOWN_MIN, 15) * 60_000;
const lastFired = new Map<string, number>();

function shouldFire(key: string): boolean {
  const now = Date.now();
  const prev = lastFired.get(key) || 0;
  if (now - prev < COOLDOWN_MS) return false;
  lastFired.set(key, now);
  return true;
}

/** Evaluate a metrics snapshot; fire superadmin notifications for any breach. */
export async function evaluate(metrics: any): Promise<string[]> {
  const fired: string[] = [];
  const breaches: Array<{ key: string; title: string; body: string }> = [];

  if (metrics.diskPct != null && metrics.diskPct >= THRESHOLDS.diskPct)
    breaches.push({ key: 'disk', title: 'Disco casi lleno', body: `Uso de disco ${metrics.diskPct}% (umbral ${THRESHOLDS.diskPct}%). /uploads puede llenarse.` });
  if (metrics.hostMemPct != null && metrics.hostMemPct >= THRESHOLDS.hostMemPct)
    breaches.push({ key: 'mem', title: 'Memoria del host alta', body: `RAM del host ${metrics.hostMemPct}% (umbral ${THRESHOLDS.hostMemPct}%).` });
  if (metrics.heapUsedPct != null && metrics.heapUsedPct >= THRESHOLDS.heapUsedPct)
    breaches.push({ key: 'heap', title: 'Heap del proceso alto', body: `Heap usado ${metrics.heapUsedPct}% (umbral ${THRESHOLDS.heapUsedPct}%). Posible fuga de memoria.` });
  if (metrics.loadPct != null && metrics.loadPct >= THRESHOLDS.loadPct)
    breaches.push({ key: 'load', title: 'Carga de CPU alta', body: `Carga ${metrics.loadPct}% de los núcleos (umbral ${THRESHOLDS.loadPct}%).` });
  if (metrics.dbPoolWaiting != null && metrics.dbPoolWaiting > THRESHOLDS.poolWaiting)
    breaches.push({ key: 'pool', title: 'Pool de BD saturado', body: `${metrics.dbPoolWaiting} conexiones en espera — el pool está saturado.` });
  if (metrics.errorCount != null && metrics.errorCount >= THRESHOLDS.errorSpike)
    breaches.push({ key: 'errors', title: 'Pico de errores', body: `${metrics.errorCount} errores en el último minuto (umbral ${THRESHOLDS.errorSpike}).` });
  if (metrics.jobErrors != null && metrics.jobErrors > 0)
    breaches.push({ key: 'jobs', title: 'Tarea en error', body: `${metrics.jobErrors} tarea(s) programada(s) fallando.` });

  if (!breaches.length) return fired;

  const models = require('../database/models').default;
  const db = models();
  for (const b of breaches) {
    if (!shouldFire(b.key)) continue;
    try {
      await createNotification(db, {
        type: `alert.${b.key}`,
        title: `⚠️ ${b.title}`,
        body: b.body,
        link: '/observability',
        icon: 'AlertTriangle',
        metadata: { metrics, threshold: (THRESHOLDS as any)[b.key === 'errors' ? 'errorSpike' : b.key === 'pool' ? 'poolWaiting' : b.key] },
      });
      // Also deliver OFF-PANEL (email / Slack / SMS) so it reaches an on-call human.
      try {
        require('./alertChannels').sendOffPanelAlert({ key: b.key, title: b.title, body: b.body, metrics }).catch(() => {});
      } catch { /* best-effort */ }
      fired.push(b.key);
    } catch (e: any) {
      console.error('[alertEvaluator] notify failed:', e?.message || e);
    }
  }
  return fired;
}

/**
 * Trend-based leak detection — the signal a static threshold can't catch: RSS
 * (real process memory) creeping UP over hours. Compares the latest snapshot to
 * the baseline (min over the older half of an 8h window); a large sustained rise
 * suggests a leak. Fires ONE alert (cooldown) so you learn about a slow leak from
 * an email, not from checking the panel. Runs on the leader in the snapshot job.
 */
export async function evaluateTrends(): Promise<void> {
  try {
    const models = require('../database/models').default;
    const db = models();
    if (!db.metricsSnapshot) return;
    const { Op } = db.Sequelize;
    const rows = await db.metricsSnapshot.findAll({
      where: { createdAt: { [Op.gte]: new Date(Date.now() - 8 * 3600 * 1000) } },
      attributes: ['rss'],
      order: [['createdAt', 'ASC']],
      raw: true,
    });
    const rss = (rows as any[]).map((r) => Number(r.rss || 0)).filter((n) => n > 0);
    if (rss.length < 30) return; // need ~30 min of history before trusting a trend
    const current = rss[rss.length - 1];
    const olderHalf = rss.slice(0, Math.floor(rss.length / 2));
    const baseline = Math.min(...olderHalf);
    const floorBytes = Number(process.env.ALERT_RSS_FLOOR_MB || 350) * 1048576;
    const growth = Number(process.env.ALERT_RSS_GROWTH || 1.5); // 1.5 = +50%
    if (baseline > 0 && current > baseline * growth && current > floorBytes) {
      if (!shouldFire('rss_trend')) return;
      const mb = (b: number) => `${Math.round(b / 1048576)}MB`;
      const pct = Math.round((current / baseline - 1) * 100);
      const title = 'Posible fuga de memoria';
      const body = `El RSS del proceso creció de ${mb(baseline)} a ${mb(current)} (+${pct}%) en ~8h. PM2 reinicia a 450MB (sin caída), pero conviene revisar si sigue subiendo.`;
      const models2 = require('../database/models').default;
      const { createNotification } = require('../services/superadmin/superadminNotificationService');
      await createNotification(models2(), {
        type: 'alert.rss_trend', title: `⚠️ ${title}`, body,
        link: '/observability/workers', icon: 'AlertTriangle', metadata: { baseline, current, pct },
      });
      require('./alertChannels').sendOffPanelAlert({ key: 'rss_trend', title, body }).catch(() => {});
    }
  } catch (e: any) {
    console.error('[alertEvaluator:trends]', e?.message || e);
  }
}
