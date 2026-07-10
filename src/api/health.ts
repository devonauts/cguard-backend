/**
 * Health Check Endpoint for CGUARD Backend
 * 
 * Used by:
 * - Load balancers (HAProxy, Nginx, AWS ALB)
 * - Kubernetes liveness/readiness probes
 * - Monitoring systems (Prometheus, Datadog)
 * - PM2 cluster mode coordination
 */

import { Router, Request, Response } from 'express';
import { getConfig } from '../config';

const router = Router();

interface HealthStatus {
  status: 'healthy' | 'degraded' | 'unhealthy';
  timestamp: string;
  uptime: number;
  version: string;
  environment: string;
  checks: {
    database: { status: string; latency?: number; error?: string };
    memory: { status: string; used: number; limit: number; percentage: number };
    tenantMode: string;
  };
}

/**
 * GET /api/health
 * 
 * Returns health status of the application.
 * Status codes:
 * - 200: Healthy
 * - 503: Unhealthy (use for load balancer to remove from rotation)
 */
router.get('/health', async (req: Request, res: Response) => {
  const startTime = Date.now();
  
  const health: HealthStatus = {
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    version: process.env.npm_package_version || '1.0.0',
    environment: process.env.NODE_ENV || 'development',
    checks: {
      database: { status: 'unknown' },
      memory: { status: 'unknown', used: 0, limit: 0, percentage: 0 },
      tenantMode: process.env.TENANT_MODE || 'single',
    },
  };

  // Check database connectivity
  try {
    const database = (req as any).database;
    if (database && database.sequelize) {
      const dbStart = Date.now();
      await database.sequelize.authenticate();
      health.checks.database = {
        status: 'connected',
        latency: Date.now() - dbStart,
      };
    } else {
      health.checks.database = { status: 'not_initialized' };
    }
  } catch (error: any) {
    health.status = 'unhealthy';
    health.checks.database = {
      status: 'disconnected',
      error: error.message || 'Unknown database error',
    };
  }

  // Check memory usage
  const memUsage = process.memoryUsage();
  const memLimit = 1024 * 1024 * 1024; // 1GB limit
  const memPercentage = (memUsage.heapUsed / memLimit) * 100;
  
  health.checks.memory = {
    status: memPercentage > 90 ? 'critical' : memPercentage > 70 ? 'warning' : 'ok',
    used: Math.round(memUsage.heapUsed / 1024 / 1024), // MB
    limit: Math.round(memLimit / 1024 / 1024), // MB
    percentage: Math.round(memPercentage * 100) / 100,
  };

  if (memPercentage > 90) {
    health.status = 'degraded';
  }

  // Realtime cluster delivery: degraded = PM2 cluster worker without a working
  // socket.io Redis adapter (cross-instance emits, incl. panic alerts, are lost).
  try {
    const realtime = require('../lib/realtime').getRealtimeHealth();
    (health.checks as any).realtime = realtime;
    if (realtime?.degraded && health.status === 'healthy') {
      health.status = 'degraded';
    }
  } catch { /* realtime module optional */ }

  // Return appropriate status code
  const statusCode = health.status === 'unhealthy' ? 503 : 200;
  res.status(statusCode).json(health);
});

/**
 * GET /api/health/ready
 * 
 * Readiness probe - returns 200 only when app is ready to receive traffic.
 * Use for Kubernetes readiness probes or load balancer health checks.
 */
router.get('/health/ready', async (req: Request, res: Response) => {
  try {
    const database = (req as any).database;
    if (database && database.sequelize) {
      await database.sequelize.authenticate();
      // Surface pool saturation — a full pool still authenticates(), so connectivity
      // alone hid the exhaustion that caused the mass-logout incident. Reported for
      // monitoring; readiness stays 200 unless the DB is actually unreachable (shedding
      // this instance while every instance is saturated would only make it worse).
      let pool: any = null;
      try {
        const p: any = database.sequelize.connectionManager?.pool;
        if (p) {
          // sequelize-pool 7.x getters: using / waiting / maxSize.
          const using = Number(p.using ?? p.size ?? 0);
          const max = Number(p.maxSize ?? 0);
          pool = {
            using,
            waiting: Number(p.waiting ?? 0),
            max,
            saturationPct: max ? Math.round((using / max) * 100) : null,
          };
        }
      } catch { /* pool introspection optional */ }
      res.status(200).json({ ready: true, pool });
    } else {
      res.status(503).json({ ready: false, reason: 'database_not_initialized' });
    }
  } catch (error: any) {
    res.status(503).json({ ready: false, reason: error.message });
  }
});

/**
 * GET /api/health/live
 * 
 * Liveness probe - returns 200 if process is alive.
 * Use for Kubernetes liveness probes.
 */
router.get('/health/live', (req: Request, res: Response) => {
  res.status(200).json({ alive: true, uptime: process.uptime() });
});

/**
 * GET /api/metrics — Prometheus text exposition for APM scraping (Grafana Agent,
 * Datadog OpenMetrics, etc.). Gated by METRICS_TOKEN (Bearer); if unset, only
 * localhost may scrape (so it's never accidentally public).
 */
router.get('/metrics', async (req: Request, res: Response) => {
  const token = process.env.METRICS_TOKEN;
  if (token) {
    if ((req.headers.authorization || '') !== `Bearer ${token}`) { res.status(401).send('unauthorized\n'); return; }
  } else {
    const ip = String(req.ip || (req.socket && req.socket.remoteAddress) || '');
    if (!/127\.0\.0\.1|::1/.test(ip)) { res.status(403).send('# set METRICS_TOKEN to enable remote scraping\n'); return; }
  }

  const lines: string[] = [];
  const gauge = (name: string, help: string, val: number | null | undefined) => {
    if (val == null || Number.isNaN(val as number)) return;
    lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`, `${name} ${val}`);
  };

  const mem = process.memoryUsage();
  gauge('cguard_process_rss_bytes', 'Resident set size', mem.rss);
  gauge('cguard_process_heap_used_bytes', 'Heap used', mem.heapUsed);
  gauge('cguard_process_heap_total_bytes', 'Heap total', mem.heapTotal);
  gauge('cguard_process_uptime_seconds', 'Process uptime', Math.round(process.uptime()));

  try {
    const p: any = (req as any).database?.sequelize?.connectionManager?.pool;
    if (p) {
      gauge('cguard_db_pool_using', 'DB connections in use', p.using ?? p.size ?? 0);
      gauge('cguard_db_pool_waiting', 'DB connection requests waiting', p.waiting ?? 0);
      gauge('cguard_db_pool_max', 'DB pool max size', p.maxSize ?? 0);
    }
  } catch { /* ignore */ }
  try {
    const slow = require('../lib/slowQueryMonitor').getSlowQueries();
    gauge('cguard_slow_queries_total', 'Slow queries since boot', slow.totalSlow);
    gauge('cguard_slow_query_max_ms', 'Slowest query (ms)', slow.maxMs);
  } catch { /* ignore */ }
  try {
    const jobErrors = require('../lib/jobsMonitor').getJobs().filter((j: any) => j.lastStatus === 'error').length;
    gauge('cguard_job_errors', 'Scheduled jobs currently failing', jobErrors);
  } catch { /* ignore */ }
  try {
    const q = await require('../lib/queue').queueStatus();
    if (q?.counts) {
      gauge('cguard_queue_waiting', 'Queue jobs waiting', q.counts.waiting);
      gauge('cguard_queue_active', 'Queue jobs active', q.counts.active);
      gauge('cguard_queue_failed', 'Queue jobs failed', q.counts.failed);
    }
  } catch { /* ignore */ }

  res.set('Content-Type', 'text/plain; version=0.0.4').send(lines.join('\n') + '\n');
});

export default function (routes: Router) {
  routes.use('/', router);
}
