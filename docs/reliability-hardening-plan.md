# C-Guard Pro — Reliability Hardening Plan (enterprise scale)

_Written 2026-07-07 after the mass-logout incident. Audience: hundreds of guards +
client + supervisor + CRM users hitting one backend + one MySQL, 24/7._

## What happened (the incident that triggered this)

Ecuaseguridad users "kept getting logged out" mid-session. Root cause was a
**cascade**, not a single bug:

1. MySQL ran on stock defaults — `max_connections=151`, `innodb_buffer_pool_size=128MB`
   on a **15 GB / 4-core box** — so the app's connection pools exhausted the DB
   (`Connection_errors_max_connections` = 3,194; "Too many connections" ~2,090× in one day).
2. `authMiddleware` validated tokens with DB lookups and returned **401 for ANY error**
   — so a transient DB blip looked like an invalid session.
3. The CRM logs out on 401 → users kicked mid-action.

The lesson for enterprise scale: **a single resource ceiling cascaded into an
auth outage for a whole tenant.** This plan removes the ceilings and the cascades.

## Phase 0 — DONE (2026-07-07): stop the bleeding

| Fix | Detail | Status |
|-----|--------|--------|
| Auth fail-open | Infra/DB errors during token validation → **503 (retryable), session preserved** — not 401. `errors/isInfrastructureError.ts` + authMiddleware + findByToken. | Deployed (24fb13b) |
| MySQL sizing | `max_connections` 151→**500**; `innodb_buffer_pool_size` 128MB→**6 GB**; `thread_cache_size` 9→64. Applied online (no restart) + persisted in `mysql.conf.d/zz-cguard-tuning.cnf`. | Applied |
| App pool | `DATABASE_POOL_MAX` 50→**25**, `MIN` 10→**5** per process (server `.env`). Total ≈ 4 pools × 25 = 100 ≪ 500. | Applied |
| CRM resilience | Retry idempotent GETs up to 3× on 502/503/504 + dropped connection. Mutations never retried. | Deployed (3db10cc) |

Box has huge headroom (13 GB RAM free, load ~0.2) — the problem was **config, not hardware.**

## Phase 1 — Harden the single box (this week · low risk · no new infra)

1. **Connection leak audit** — verify every `SequelizeRepository.getTransaction` site
   (~10) commits/rolls back in a `finally`. A leaked transaction pins a connection;
   at scale that silently drains the pool.
2. **Driver-level retry** — add Sequelize `retry: { max: 3 }` for transient connection
   errors/deadlocks so the DB layer self-heals before the request ever fails.
3. **Readiness endpoint** — `/health/ready` reporting pool saturation + a DB ping, so
   monitoring/nginx can shed load gracefully instead of hard-failing.
4. **Scheduler isolation** — confirm single-leader election (heartbeat-lock already
   exists), stagger intervals, and cap scheduler DB usage so a metrics/alert sweep
   can't starve request-serving connections.
5. **Proactive alerting** — wire the existing observability collectors to ALERT when
   `Threads_connected` > 70% of `max_connections`, pool acquire-wait rises, or RAM
   > 80% — _before_ it becomes an outage.
6. **Slow-query pass** — `Slow_queries=0` means the threshold is too high. Lower
   `long_query_time`, enable the slow log, and index the hot paths (location pings,
   shift/attendance lookups, list endpoints). With the new 6 GB buffer pool this is a
   large, cheap win. Pairs with the in-flight payload-perf work.

## Phase 2 — Redundancy & scale-out (this month · new infra)

1. **Separate / managed MySQL** (own box or RDS/Cloud SQL/Aurora): automated backups,
   point-in-time recovery, failover. Removes the single-box **data-loss P0** — today
   MySQL, the API, schedulers, and the SIP bridge share one machine with no backups.
2. **Read replica** — route heavy reads (reports, analytics, superadmin dashboards,
   big list endpoints) to a replica; offloads the primary.
3. **Connection pooler** (ProxySQL / RDS Proxy) — multiplex many app connections into
   a small DB-side pool; smooths bursts and lets the API scale horizontally without
   re-exhausting the DB.
4. **Object storage for uploads** (S3/GCS) — move evidence photos off local disk:
   durable, CDN-able, and a prerequisite for multiple stateless API instances.
5. **Horizontal API scale** behind a load balancer — JWT is already stateless; add
   instances/boxes and autoscale on CPU/connection pressure.

## Phase 3 — Operational excellence (ongoing)

- Automated, **tested** backups + PITR (a backup you haven't restored isn't a backup).
- **Load testing**: simulate N-hundred guards polling to find the next ceiling before
  customers do.
- **Graceful degradation**: circuit-breakers on non-critical subsystems (email, push,
  analytics) so they can never take down auth / clock-in.
- Per-tenant / per-user rate limiting to contain a runaway client.
- Rolling / blue-green deploys incl. DB migrations (PM2 reload is already zero-downtime).

## Capacity sanity check for "hundreds of guards"

500 guards pinging location every ~45 s ≈ 11 writes/s baseline + reads — trivially
handled by the now-tuned single box **once the hot queries are indexed and the buffer
pool is warm**. The ceiling was connections + un-cached disk reads, both addressed in
Phase 0. Phase 2 (replica + pooler + managed DB) is about **redundancy and the jump to
thousands**, not raw throughput for hundreds.

## Priority order

Phase 0 (done) → 1.1 leak audit → 1.5 alerting → 1.6 slow-query/indexing →
2.1 managed DB + backups → 2.4 object storage → 2.2 replica / 2.3 pooler →
horizontal scale. Backups + indexing give the most safety per unit of effort.
