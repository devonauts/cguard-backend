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
      fired.push(b.key);
    } catch (e: any) {
      console.error('[alertEvaluator] notify failed:', e?.message || e);
    }
  }
  return fired;
}
