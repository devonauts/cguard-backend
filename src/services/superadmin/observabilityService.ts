/**
 * SuperAdmin · observability + dashboard service.
 *
 * Powers three cross-tenant, read-only views for the platform owner:
 *   - the home dashboard (tenant/user/billing rollups + recent activity),
 *   - the system health report (db connectivity, latency, process stats),
 *   - the row-count snapshot and the audit-log feed.
 *
 * Reuses the platform pricing engine (src/lib/billingModel.ts) — pricing math
 * is NEVER duplicated here. All money values are in cents. Queries run
 * cross-tenant (no tenant filter) off the models bag attached to the request.
 */
import { Request } from 'express';
import os from 'os';
import { db, listParams } from './superadminHelpers';
import { quote } from '../../lib/billingModel';
import { getSlowQueries, clearSlowQueries } from '../../lib/slowQueryMonitor';
import { getJobs } from '../../lib/jobsMonitor';
import { getAllWorkers } from '../../lib/workerMetrics';

/** Build a tenantId → seat-count map in a single grouped query (avoids N+1). */
async function seatCountsByTenant(database: any): Promise<Record<string, number>> {
  const { fn, col } = database.Sequelize;
  const rows: any[] = await database.tenantUser.findAll({
    attributes: ['tenantId', [fn('COUNT', col('id')), 'c']],
    group: ['tenantId'],
    raw: true,
  });
  const map: Record<string, number> = {};
  for (const r of rows) {
    map[r.tenantId] = parseInt(r.c, 10) || 0;
  }
  return map;
}

/** Map a tenant row to the contract's TenantRow shape (seats + mrrCents). */
function toTenantRow(t: any, seats: number): any {
  const active = (t.billingStatus || 'trialing') === 'active';
  const mrrCents = active ? quote(seats, false).monthlyCents : 0;
  return {
    id: t.id,
    name: t.name,
    url: t.url || null,
    email: t.email || null,
    plan: t.plan || null,
    planStatus: t.planStatus || null,
    billingStatus: t.billingStatus || 'trialing',
    suspendedAt: t.suspendedAt || null,
    seats,
    mrrCents,
    trialEndsAt: t.trialEndsAt || null,
    createdAt: t.createdAt,
  };
}

/** Map a superAdminAuditLog row to the contract's AuditEntry shape. */
function toAuditEntry(a: any): any {
  return {
    id: a.id,
    actorUserId: a.actorUserId ?? null,
    actorEmail: a.actorEmail ?? null,
    action: a.action,
    targetType: a.targetType ?? null,
    targetId: a.targetId ?? null,
    tenantId: a.tenantId ?? null,
    method: a.method ?? null,
    path: a.path ?? null,
    ip: a.ip ?? null,
    statusCode: a.statusCode ?? null,
    details: a.details ?? null,
    createdAt: a.createdAt,
  };
}

/** GET /dashboard → DashboardData */
export async function dashboard(req: Request): Promise<any> {
  const database = db(req);
  const { Op } = database.Sequelize;

  const monthAgo = new Date();
  monthAgo.setMonth(monthAgo.getMonth() - 1);

  // ── Tenant counts (cheap parallel COUNTs). ──────────────────────────────
  const [
    total,
    active,
    trialing,
    pastDue,
    suspended,
    canceled,
    newThisMonth,
  ] = await Promise.all([
    database.tenant.count(),
    database.tenant.count({ where: { billingStatus: 'active' } }),
    database.tenant.count({ where: { billingStatus: 'trialing' } }),
    database.tenant.count({ where: { billingStatus: 'past_due' } }),
    database.tenant.count({ where: { suspendedAt: { [Op.ne]: null } } }),
    database.tenant.count({ where: { billingStatus: 'canceled' } }),
    database.tenant.count({ where: { createdAt: { [Op.gte]: monthAgo } } }),
  ]);

  // ── User counts. `total` = every platform account (incl. tenant-less &
  // superadmins); `staff` = tenant memberships (one billable seat each);
  // guards = securityGuard rows. ──────────────────────────────────────────
  const [userTotal, staff, guards] = await Promise.all([
    database.user.count(),
    database.tenantUser.count(),
    database.securityGuard.count(),
  ]);

  // ── Billing rollup over active tenants (reuse seat map + pricing engine). ─
  const activeTenants: any[] = await database.tenant.findAll({
    where: { billingStatus: 'active' },
    raw: true,
  });
  const seatMap = await seatCountsByTenant(database);
  const trialingTenants = trialing;

  let mrrCents = 0;
  let netMrrCents = 0;
  let activeSeats = 0;
  for (const t of activeTenants) {
    const seats = seatMap[t.id] || 0;
    const q = quote(seats, false);
    mrrCents += q.monthlyCents;
    netMrrCents += q.netMonthlyCents;
    activeSeats += seats;
  }

  // ── Recent activity. ─────────────────────────────────────────────────────
  const recentTenantRows: any[] = await database.tenant.findAll({
    order: [['createdAt', 'DESC']],
    limit: 5,
    raw: true,
  });
  const recentTenants = recentTenantRows.map((t) =>
    toTenantRow(t, seatMap[t.id] || 0),
  );

  let recentAudit: any[] = [];
  if (database.superAdminAuditLog) {
    const auditRows: any[] = await database.superAdminAuditLog.findAll({
      order: [['createdAt', 'DESC']],
      limit: 8,
      raw: true,
    });
    recentAudit = auditRows.map(toAuditEntry);
  }

  return {
    tenants: {
      total,
      active,
      trialing,
      pastDue,
      suspended,
      canceled,
      newThisMonth,
    },
    users: {
      total: userTotal,
      guards,
      staff,
    },
    billing: {
      mrrCents,
      arrCents: mrrCents * 12,
      netMrrCents,
      payingTenants: active,
      trialingTenants,
      activeSeats,
    },
    recentTenants,
    recentAudit,
  };
}

/** GET /observability/health → HealthReport */
export async function health(req: Request): Promise<any> {
  const database = db(req);
  const sequelize = database.sequelize;

  let connected = false;
  let latencyMs: number | null = null;
  let dialect: string | null = null;

  try {
    dialect = sequelize.getDialect();
  } catch {
    dialect = null;
  }

  try {
    const started = Date.now();
    await sequelize.authenticate();
    await sequelize.query('SELECT 1');
    latencyMs = Date.now() - started;
    connected = true;
  } catch {
    connected = false;
    latencyMs = null;
  }

  const mem = process.memoryUsage();

  return {
    status: connected ? 'ok' : 'down',
    database: { connected, dialect, latencyMs },
    uptimeSeconds: process.uptime(),
    memory: {
      rss: mem.rss,
      heapUsed: mem.heapUsed,
      heapTotal: mem.heapTotal,
    },
    nodeVersion: process.version,
    timestamp: new Date().toISOString(),
  };
}

/** GET /observability/stats → { tables: { name, count }[] } */
export async function stats(req: Request): Promise<any> {
  const database = db(req);
  const names = [
    'tenant',
    'tenantUser',
    'securityGuard',
    'user',
    'clientAccount',
    'businessInfo',
    'incident',
    'invoice',
  ];

  const tables: { name: string; count: number }[] = [];
  for (const name of names) {
    const model = database[name];
    if (!model || typeof model.count !== 'function') continue;
    try {
      const count = await model.count();
      tables.push({ name, count });
    } catch {
      // Skip any model that errors (missing table, dialect quirk, etc.).
    }
  }

  return { tables };
}

/** GET /audit → Paginated<AuditEntry> (filters: action, tenantId, actorUserId) */
export async function auditLog(req: Request): Promise<any> {
  const database = db(req);
  const { page, limit, offset } = listParams(req.query);

  const q = req.query as any;
  const { Op } = database.Sequelize;
  const where: any = {};
  if (q?.action) where.action = String(q.action).trim();
  else if (q?.actionPrefix) where.action = { [Op.like]: `${String(q.actionPrefix).trim()}%` };
  if (q?.tenantId) where.tenantId = String(q.tenantId).trim();
  if (q?.actorUserId) where.actorUserId = String(q.actorUserId).trim();

  if (!database.superAdminAuditLog) {
    return { rows: [], count: 0, page, limit, totalPages: 1 };
  }

  const { rows, count } = await database.superAdminAuditLog.findAndCountAll({
    where,
    order: [['createdAt', 'DESC']],
    limit,
    offset,
    raw: true,
  });

  return {
    rows: rows.map(toAuditEntry),
    count,
    page,
    limit,
    totalPages: Math.ceil(count / limit) || 1,
  };
}

// ── System resources (RAM / memory-leak watch, CPU, storage, uptime) ──────────
/** GET /observability/system */
export async function system(_req: Request): Promise<any> {
  const mem = process.memoryUsage();
  const totalmem = os.totalmem();
  const freemem = os.freemem();
  const load = os.loadavg();
  const cpus = os.cpus()?.length || 1;

  // Disk usage for the app root (Node 18.15+ has fs.statfs).
  let disk: any = null;
  try {
    const sfs: any = require('fs');
    if (sfs.statfsSync) {
      const s = sfs.statfsSync(process.cwd());
      const total = s.blocks * s.bsize;
      const free = s.bfree * s.bsize;
      disk = { total, free, used: total - free, usedPct: total ? Math.round(((total - free) / total) * 1000) / 10 : null };
    }
  } catch {
    /* statfs unavailable */
  }

  return {
    process: {
      rss: mem.rss,
      heapUsed: mem.heapUsed,
      heapTotal: mem.heapTotal,
      external: mem.external,
      arrayBuffers: (mem as any).arrayBuffers || 0,
      heapUsedPct: mem.heapTotal ? Math.round((mem.heapUsed / mem.heapTotal) * 1000) / 10 : null,
      uptimeSeconds: Math.round(process.uptime()),
      pid: process.pid,
      pm2Instance: process.env.NODE_APP_INSTANCE ?? process.env.pm_id ?? null,
      nodeVersion: process.version,
    },
    memory: {
      total: totalmem,
      free: freemem,
      used: totalmem - freemem,
      usedPct: Math.round(((totalmem - freemem) / totalmem) * 1000) / 10,
    },
    cpu: { cores: cpus, load1: load[0], load5: load[1], load15: load[2], loadPct: Math.round((load[0] / cpus) * 1000) / 10 },
    disk,
    host: { platform: os.platform(), hostname: os.hostname(), uptimeSeconds: Math.round(os.uptime()) },
    timestamp: new Date().toISOString(),
  };
}

// ── DB performance (pool, size, slow-query digests) ───────────────────────────
/** GET /observability/db */
export async function dbPerformance(req: Request): Promise<any> {
  const database = db(req);
  const sequelize = database.sequelize;

  // Connection pool snapshot (defensive — internals vary by version).
  let pool: any = null;
  try {
    const p: any = sequelize.connectionManager?.pool;
    if (p) pool = { size: p.size, available: p.available, using: p.using ?? p.borrowed, waiting: p.pending ?? p.waiting, max: p.maxSize, min: p.minSize };
  } catch {
    /* ignore */
  }

  // Database size.
  let dbSize: any = null;
  try {
    const [[row]]: any = await sequelize.query(
      "SELECT COUNT(*) AS tables, COALESCE(SUM(data_length + index_length),0) AS bytes FROM information_schema.tables WHERE table_schema = DATABASE()",
    );
    dbSize = { tables: Number(row.tables), bytes: Number(row.bytes) };
  } catch {
    /* ignore */
  }

  // Slowest query patterns from performance_schema (>= 0.1s avg). Best-effort —
  // performance_schema may be disabled.
  let digests: any[] = [];
  let perfSchema = true;
  try {
    const [rows]: any = await sequelize.query(
      `SELECT LEFT(digest_text, 400) AS sql_text, count_star AS calls,
              ROUND(avg_timer_wait/1e12, 4) AS avg_s,
              ROUND(max_timer_wait/1e12, 4) AS max_s,
              ROUND(sum_timer_wait/1e12, 2) AS total_s,
              sum_rows_examined AS rows_examined, last_seen
       FROM performance_schema.events_statements_summary_by_digest
       WHERE avg_timer_wait/1e12 >= 0.1 AND digest_text IS NOT NULL
       ORDER BY avg_timer_wait DESC LIMIT 50`,
    );
    digests = rows;
  } catch {
    perfSchema = false;
  }

  return { pool, dbSize, perfSchema, digests, timestamp: new Date().toISOString() };
}

/** GET /observability/jobs → background-job health (per worker). */
export async function jobs(_req: Request): Promise<any> {
  return { jobs: getJobs(), pid: process.pid, timestamp: new Date().toISOString() };
}

/** GET /observability/slow-queries → captured queries >= threshold (0.1s). */
export async function slowQueries(_req: Request): Promise<any> {
  return { ...getSlowQueries(), pid: process.pid, timestamp: new Date().toISOString() };
}

/** DELETE /observability/slow-queries → reset the capture buffer. */
export async function resetSlowQueries(_req: Request): Promise<any> {
  return clearSlowQueries();
}

/** GET /observability/workers → per-PM2-worker resource snapshots (RAM breakdown). */
export async function workers(_req: Request): Promise<any> {
  return { ...(await getAllWorkers()), timestamp: new Date().toISOString() };
}
