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
              sum_rows_examined AS rows_examined, sum_rows_sent AS rows_sent,
              sum_no_index_used AS no_index_used, sum_no_good_index_used AS no_good_index_used,
              last_seen
       FROM performance_schema.events_statements_summary_by_digest
       WHERE avg_timer_wait/1e12 >= 0.1 AND digest_text IS NOT NULL
       ORDER BY avg_timer_wait DESC LIMIT 50`,
    );
    // Flag likely-missing-index patterns: queries that scan without an index, or
    // examine far more rows than they return (examined:sent ratio).
    digests = (rows as any[]).map((r) => {
      const examined = Number(r.rows_examined || 0);
      const sent = Number(r.rows_sent || 0);
      const ratio = sent > 0 ? Math.round((examined / sent) * 10) / 10 : (examined > 0 ? examined : 0);
      return {
        ...r,
        examineRatio: ratio,
        fullScan: Number(r.no_index_used || 0) > 0 || Number(r.no_good_index_used || 0) > 0 || ratio >= 100,
      };
    });
  } catch {
    perfSchema = false;
  }

  return { pool, dbSize, perfSchema, digests, timestamp: new Date().toISOString() };
}

/** GET /observability/jobs → background-job health (per worker). */
export async function jobs(_req: Request): Promise<any> {
  // Merge every PM2 worker's stats (schedulers run only on the leader) so the
  // Jobs table is complete regardless of which worker serves this request.
  const { getMergedJobs } = require('../../lib/jobsMonitor');
  return { jobs: await getMergedJobs(), pid: process.pid, timestamp: new Date().toISOString() };
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

// ── Application errors (the "Errores" page) ───────────────────────────────────
/**
 * GET /observability/errors — cross-tenant error feed + grouped patterns + an
 * hourly rate series for a sparkline. Query: minutes (default 1440, max 20160),
 * limit (default 100), resolved ('true'|'false'), fingerprint, tenantId, q.
 */
export async function errors(req: Request): Promise<any> {
  const database = db(req);
  if (!database.errorEvent) {
    return { window: 0, total: 0, patterns: [], recent: [], series: [], perfSchema: false };
  }
  const { Op, fn, col, literal } = database.Sequelize;
  const q = req.query as any;
  const minutes = Math.min(Math.max(Number(q.minutes) || 1440, 5), 20160);
  const since = new Date(Date.now() - minutes * 60000);
  const limit = Math.min(Math.max(Number(q.limit) || 100, 1), 500);

  const where: any = { createdAt: { [Op.gte]: since } };
  if (q.resolved === 'true') where.resolved = true;
  else if (q.resolved === 'false') where.resolved = false;
  if (q.fingerprint) where.fingerprint = String(q.fingerprint).trim();
  if (q.tenantId) where.tenantId = String(q.tenantId).trim();
  if (q.source) where.source = String(q.source).trim();
  if (q.q) where.message = { [Op.like]: `%${String(q.q).trim()}%` };

  const [total, unresolved, patternsRaw, recent, seriesRaw] = await Promise.all([
    database.errorEvent.count({ where }),
    database.errorEvent.count({ where: { ...where, resolved: false } }),
    database.errorEvent.findAll({
      where,
      attributes: [
        'fingerprint',
        [fn('COUNT', col('id')), 'count'],
        [fn('MAX', col('createdAt')), 'lastSeen'],
        [fn('MIN', col('createdAt')), 'firstSeen'],
        [fn('MAX', col('name')), 'name'],
        [fn('MAX', col('message')), 'message'],
        [fn('MAX', col('route')), 'route'],
        [fn('MAX', col('statusCode')), 'statusCode'],
        [fn('MAX', col('source')), 'source'],
        [fn('MIN', col('resolved')), 'resolved'],
        [fn('COUNT', fn('DISTINCT', col('tenantId'))), 'tenants'],
      ],
      group: ['fingerprint'],
      order: [[literal('count'), 'DESC']],
      limit: 30,
      raw: true,
    }),
    database.errorEvent.findAll({
      where,
      attributes: ['id', 'fingerprint', 'name', 'message', 'statusCode', 'method', 'route',
        'source', 'tenantId', 'userId', 'ip', 'requestId', 'pmInstance', 'resolved', 'createdAt'],
      order: [['createdAt', 'DESC']],
      limit,
      raw: true,
    }),
    database.errorEvent.findAll({
      where,
      attributes: [
        [fn('DATE_FORMAT', col('createdAt'), '%Y-%m-%d %H:00'), 'hour'],
        [fn('COUNT', col('id')), 'count'],
      ],
      group: [literal("DATE_FORMAT(createdAt, '%Y-%m-%d %H:00')")],
      order: [[literal('hour'), 'ASC']],
      raw: true,
    }).catch(() => []),
  ]);

  return {
    window: minutes,
    total,
    unresolved,
    patterns: patternsRaw.map((p: any) => ({
      fingerprint: p.fingerprint,
      count: Number(p.count),
      name: p.name,
      message: p.message,
      route: p.route,
      statusCode: p.statusCode,
      source: p.source,
      tenants: Number(p.tenants || 0),
      resolved: !!p.resolved,
      firstSeen: p.firstSeen,
      lastSeen: p.lastSeen,
    })),
    recent,
    series: (seriesRaw as any[]).map((s) => ({ hour: s.hour, count: Number(s.count) })),
    timestamp: new Date().toISOString(),
  };
}

/** GET /observability/errors/:fingerprint → full occurrences (incl. stack) for one pattern. */
export async function errorDetail(req: Request): Promise<any> {
  const database = db(req);
  if (!database.errorEvent) return { fingerprint: null, occurrences: [] };
  const fingerprint = String(req.params.fingerprint || '').trim();
  const occurrences = await database.errorEvent.findAll({
    where: { fingerprint },
    order: [['createdAt', 'DESC']],
    limit: 50,
    raw: true,
  });
  return { fingerprint, count: occurrences.length, occurrences };
}

/** POST /observability/errors/resolve { fingerprint, resolved } → mark a pattern (un)resolved. */
export async function resolveError(req: Request): Promise<any> {
  const database = db(req);
  if (!database.errorEvent) return { ok: false, updated: 0 };
  const body = (req.body?.data ?? req.body) || {};
  const fingerprint = String(body.fingerprint || '').trim();
  if (!fingerprint) return { ok: false, updated: 0 };
  const resolved = body.resolved === false ? false : true;
  const [updated] = await database.errorEvent.update(
    { resolved, resolvedAt: resolved ? new Date() : null },
    { where: { fingerprint } },
  );
  return { ok: true, updated, fingerprint, resolved };
}

// ── Metrics history (sparklines) + alerts ─────────────────────────────────────
/** GET /observability/system/history?hours= → per-minute time series. */
export async function systemHistory(req: Request): Promise<any> {
  const hours = Number((req.query as any).hours) || 6;
  const rows = await require('../../lib/metricsHistory').getHistory(hours);
  return { hours, points: rows, timestamp: new Date().toISOString() };
}

/** GET /observability/alerts → current thresholds + recent fired alerts. */
export async function alerts(req: Request): Promise<any> {
  const database = db(req);
  const { THRESHOLDS } = require('../../lib/alertEvaluator');
  let recent: any[] = [];
  try {
    if (database.superadminNotification) {
      const { Op } = database.Sequelize;
      recent = await database.superadminNotification.findAll({
        where: { type: { [Op.like]: 'alert.%' } },
        order: [['createdAt', 'DESC']],
        limit: 50,
        raw: true,
      });
    }
  } catch { /* ignore */ }
  return { thresholds: THRESHOLDS, recent, timestamp: new Date().toISOString() };
}

// ── DB inspection (per-table sizes + live process list) ───────────────────────
/** GET /observability/db/tables → per-table row counts + data/index size. */
export async function dbTables(req: Request): Promise<any> {
  const database = db(req);
  const sequelize = database.sequelize;
  try {
    const [rows]: any = await sequelize.query(
      "SELECT table_name AS name, table_rows AS rowCount, data_length AS dataBytes, index_length AS indexBytes, (data_length + index_length) AS totalBytes, data_free AS freeBytes " +
        "FROM information_schema.tables WHERE table_schema = DATABASE() ORDER BY (data_length + index_length) DESC LIMIT 80",
    );
    return {
      tables: (rows as any[]).map((r) => ({
        name: r.name,
        rowCount: Number(r.rowCount || 0),
        dataBytes: Number(r.dataBytes || 0),
        indexBytes: Number(r.indexBytes || 0),
        totalBytes: Number(r.totalBytes || 0),
        freeBytes: Number(r.freeBytes || 0),
      })),
      timestamp: new Date().toISOString(),
    };
  } catch (e: any) {
    return { tables: [], error: e?.message || 'query failed', timestamp: new Date().toISOString() };
  }
}

/** GET /observability/db/processlist → non-idle connections (long-runners flagged). */
export async function dbProcessList(req: Request): Promise<any> {
  const database = db(req);
  const sequelize = database.sequelize;
  try {
    const [rows]: any = await sequelize.query(
      "SELECT id, user, host, db, command, time, state, LEFT(info, 300) AS info " +
        "FROM information_schema.PROCESSLIST WHERE command <> 'Sleep' ORDER BY time DESC LIMIT 60",
    );
    return {
      processes: (rows as any[]).map((r) => ({
        id: r.id, user: r.user, host: r.host, db: r.db, command: r.command,
        time: Number(r.time || 0), state: r.state, info: r.info,
        longRunning: Number(r.time || 0) >= 5,
      })),
      timestamp: new Date().toISOString(),
    };
  } catch (e: any) {
    return { processes: [], error: e?.message || 'query failed', timestamp: new Date().toISOString() };
  }
}

// ── Access & auth events (the "Accesos" page) ─────────────────────────────────
/**
 * GET /observability/auth-events — cross-tenant auth/session/rate-limit feed +
 * top failed-login IPs/emails. Reads the existing securityAuditLog (logins,
 * failed logins, logouts, device events, and now rate_limited hits).
 */
export async function authEvents(req: Request): Promise<any> {
  const database = db(req);
  if (!database.securityAuditLog) {
    return { window: 0, rows: [], topFailedIps: [], topFailedEmails: [], timestamp: new Date().toISOString() };
  }
  const { Op, fn, col, literal } = database.Sequelize;
  const q = req.query as any;
  const minutes = Math.min(Math.max(Number(q.minutes) || 1440, 5), 20160);
  const where: any = { at: { [Op.gte]: new Date(Date.now() - minutes * 60000) } };
  if (q.event) where.event = String(q.event).trim();
  if (q.outcome) where.outcome = String(q.outcome).trim();
  if (q.ip) where.ip = String(q.ip).trim();
  if (q.email) where.email = { [Op.like]: `%${String(q.email).trim()}%` };
  if (q.tenantId) where.tenantId = String(q.tenantId).trim();
  const limit = Math.min(Math.max(Number(q.limit) || 150, 1), 500);

  const failWhere = { ...where, outcome: 'failure' };
  const [rows, topIps, topEmails] = await Promise.all([
    database.securityAuditLog.findAll({ where, order: [['at', 'DESC']], limit, raw: true }),
    database.securityAuditLog.findAll({
      where: { ...failWhere, ip: { [Op.ne]: null } },
      attributes: ['ip', [fn('COUNT', col('id')), 'count']],
      group: ['ip'], order: [[literal('count'), 'DESC']], limit: 10, raw: true,
    }),
    database.securityAuditLog.findAll({
      where: { ...failWhere, email: { [Op.ne]: null } },
      attributes: ['email', [fn('COUNT', col('id')), 'count']],
      group: ['email'], order: [[literal('count'), 'DESC']], limit: 10, raw: true,
    }),
  ]);
  return {
    window: minutes,
    rows,
    topFailedIps: (topIps as any[]).map((r) => ({ ip: r.ip, count: Number(r.count) })),
    topFailedEmails: (topEmails as any[]).map((r) => ({ email: r.email, count: Number(r.count) })),
    timestamp: new Date().toISOString(),
  };
}

// ── Account lockout controls (the "Cuentas bloqueadas" panel) ─────────────────
/** GET /observability/locked-accounts → currently locked / failing accounts. */
export async function lockedAccounts(req: Request): Promise<any> {
  const database = db(req);
  const { Op } = database.Sequelize;
  const rows = await database.user.findAll({
    where: { [Op.or]: [{ lockedUntil: { [Op.gt]: new Date() } }, { failedLoginCount: { [Op.gt]: 0 } }] },
    attributes: ['id', 'email', 'firstName', 'lastName', 'failedLoginCount', 'lockedUntil', 'lastLoginAt'],
    order: [['lockedUntil', 'DESC']],
    limit: 200,
    raw: true,
  });
  return { rows, timestamp: new Date().toISOString() };
}

/** POST /observability/accounts/action { userId, action: lock|unlock|logout }. */
export async function accountAction(req: Request): Promise<any> {
  const database = db(req);
  const body = (req.body?.data ?? req.body) || {};
  const userId = String(body.userId || '').trim();
  const action = String(body.action || '').trim();
  if (!userId || !action) return { ok: false, error: 'userId and action required' };
  if (action === 'lock') {
    await database.user.update({ lockedUntil: new Date(Date.now() + 24 * 3600 * 1000) }, { where: { id: userId } });
  } else if (action === 'unlock') {
    await database.user.update({ lockedUntil: null, failedLoginCount: 0 }, { where: { id: userId } });
  } else if (action === 'logout') {
    // Invalidate all existing JWTs for the user (force re-login everywhere).
    await database.user.update({ jwtTokenInvalidBefore: new Date() }, { where: { id: userId } });
  } else {
    return { ok: false, error: 'unknown action' };
  }
  return { ok: true, action, userId };
}

// ── EXPLAIN a query (SELECT-only) ─────────────────────────────────────────────
/** POST /observability/explain { sql } → EXPLAIN FORMAT=JSON for a single SELECT. */
export async function explainQuery(req: Request): Promise<any> {
  const database = db(req);
  const body = (req.body?.data ?? req.body) || {};
  let sql = String(body.sql || '').trim().replace(/;+\s*$/, '');
  if (!sql) return { ok: false, error: 'sql required' };
  // Hard guard: exactly one SELECT, no mutating keywords, no stacked statements.
  if (!/^select\b/i.test(sql) || /;/.test(sql) ||
      /\b(insert|update|delete|drop|alter|truncate|create|grant|replace|call|load|into\s+outfile)\b/i.test(sql)) {
    return { ok: false, error: 'Solo se permite una única sentencia SELECT de lectura.' };
  }
  try {
    const [rows]: any = await database.sequelize.query('EXPLAIN FORMAT=JSON ' + sql);
    const raw = rows?.[0]?.EXPLAIN ?? rows?.[0]?.explain ?? null;
    let plan: any = raw;
    try { plan = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { /* keep raw */ }
    return { ok: true, plan };
  } catch (e: any) {
    return { ok: false, error: e?.message || 'EXPLAIN failed' };
  }
}

// ── Job queue (the "Colas" page) ──────────────────────────────────────────────
/** GET /observability/queues → queue depth (waiting/active/failed/…) + failed jobs. */
export async function queues(_req: Request): Promise<any> {
  const status = await require('../../lib/queue').queueStatus();
  return { ...status, timestamp: new Date().toISOString() };
}

/** POST /observability/queues/retry → re-enqueue all failed (dead-letter) jobs. */
export async function queuesRetry(_req: Request): Promise<any> {
  return { retried: await require('../../lib/queue').retryFailed() };
}

/** POST /observability/queues/drain → clear the failed set. */
export async function queuesDrain(_req: Request): Promise<any> {
  return { removed: await require('../../lib/queue').drainFailed() };
}
