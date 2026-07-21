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
  dbConnPct: num(process.env.ALERT_DB_CONN_PCT, 80), // MySQL-global Threads_connected / max_connections
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
  // Server-global connection saturation: the EARLY warning before MySQL rejects
  // with "Too many connections" (the mass-logout root cause). Fires before the
  // per-process pool even starts queuing.
  if (metrics.dbConnPct != null && metrics.dbConnPct >= THRESHOLDS.dbConnPct)
    breaches.push({ key: 'dbconn', title: 'Conexiones de BD altas', body: `MySQL usando ${metrics.dbConnPct}% de las conexiones (${metrics.dbThreadsConnected}/${metrics.dbMaxConnections}, umbral ${THRESHOLDS.dbConnPct}%). Riesgo de "Too many connections".` });
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
        metadata: { metrics, threshold: (THRESHOLDS as any)[b.key === 'errors' ? 'errorSpike' : b.key === 'pool' ? 'poolWaiting' : b.key === 'dbconn' ? 'dbConnPct' : b.key] },
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
    if (rss.length < 30) return;
    // Only look at the CURRENT process's lifetime — trim everything up to the last
    // RESTART (a >30% drop between consecutive samples = PM2 recycled the worker).
    // The sawtooth of climbing to max_memory_restart then dropping is NOT a leak;
    // treating post-restart warmup growth as a leak is what caused the false alarm.
    let start = 0;
    for (let i = 1; i < rss.length; i++) if (rss[i] < rss[i - 1] * 0.7) start = i;
    const life = rss.slice(start);
    // Require ≥2h of continuous uptime before trusting a trend (past warmup).
    if (life.length < 120) return;
    const current = life[life.length - 1];
    // Baseline = min AFTER the first ~30min of warmup within this process life. A
    // real leak = a process up >2h that is STILL climbing above its steady floor.
    const steady = life.slice(30);
    const baseline = steady.length ? Math.min(...steady) : Math.min(...life);
    const floorBytes = Number(process.env.ALERT_RSS_FLOOR_MB || 350) * 1048576;
    const growth = Number(process.env.ALERT_RSS_GROWTH || 1.5); // 1.5 = +50%
    if (baseline > 0 && current > baseline * growth && current > floorBytes) {
      if (!shouldFire('rss_trend')) return;
      const mb = (b: number) => `${Math.round(b / 1048576)}MB`;
      const pct = Math.round((current / baseline - 1) * 100);
      // The restart ceiling comes from the PM2 config (max_memory_restart, 900M).
      // env-overridable so the alert text stays truthful if the ceiling changes.
      const ceilingMb = num(process.env.ALERT_RESTART_CEILING_MB, 900);
      const title = 'Posible fuga de memoria';
      const body = `El RSS del proceso creció de ${mb(baseline)} a ${mb(current)} (+${pct}%) en ~8h. PM2 reinicia el worker a ${ceilingMb}MB (sin caída de servicio), pero conviene revisar si sigue subiendo. Nota: una operación masiva puntual (auto-asignar/optimizar muchas estaciones a la vez) puede inflar el RSS de forma transitoria sin ser una fuga.`;
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
