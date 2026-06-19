All claims verified against the real codebase. The PORT discrepancy (ecosystem says 8080, server.ts defaults to 3001) and the auditLog having no `indexes` block are confirmed. I have enough grounding to write the document.

# CGuard Pro — Enterprise Architecture to 100,000 Users

*Principal architect's decision document. Grounded in the actual codebase at `/Users/mike/cguard-pro/{backend,frontend,superadmin,worker-app}`. Decisive, not a survey.*

---

## 1) Executive Summary — the 8 things that matter most

1. **You are one box away from total loss.** Everything — MySQL, Redis, the API, the alarm receiver, and *all uploaded media* (clock-in selfies, ID photos, incident evidence, radio audio in `/uploads`) — lives on a single ~15.6GB/4-core node behind a Cloudflare Tunnel. No replica, no backup-restore drill, no failover. If that disk dies, the business dies. **This is the #1 problem and it is not a scale problem — it's a survival problem today.**

2. **The database pool is silently capped at 5 connections per worker.** `ecosystem.config.js` sets `DATABASE_POOL_MAX=50`, but `src/database/models/index.ts` constructs Sequelize with **no `pool` block at all**, so those env vars are dead config. With 2 workers you have ~10 MySQL connections for the entire platform. This is a one-line-per-field fix that unlocks an order of magnitude of throughput. **Do it this week.**

3. **The app is not actually stateless** — and three specific things prevent horizontal scaling: local-disk uploads, in-process `setInterval` schedulers in `server.ts`, and a per-worker in-memory rate limiter. The S3/GCS storage providers *already exist* in `src/services/file/fileStorage.ts` (just gated behind `FILE_STORAGE_PROVIDER`). Fixing these three turns "1 node" into "N nodes behind a load balancer."

4. **Read amplification will melt MySQL long before CPU does.** `securityGuardRepository.findAndCountAll` fires ~6–7 queries *per row* (`_fillWithRelationsAndFiles`) → a 25-row guard list = ~175 queries. `dashboardService` loops 12 months with sequential `await count/sum`. `authMiddleware` hits the DB (`findByToken` + permission map) on **every** authenticated request with no cache. At 100k users this is the dominant load multiplier.

5. **Background jobs steal CPU and DB connections from live traffic.** Nine schedulers run *inside the request-serving workers*, including `AttendanceDetection` (`shift.findAll({limit:2000})` then N+1 per shift) and per-minute all-tenant loops (`RadioCheck`, `Consigna`). They must move to a dedicated worker tier on a real queue (BullMQ).

6. **Single Redis is a silent SPOF for realtime and radio.** socket.io broadcast (`realtime.ts`) and the live PCM radio relay (`radioVoice.ts`) both fall back to *single-worker mode* when `REDIS_URL` is unset — degrading silently. Redis must be managed, HA, and guaranteed-present in prod before you run a second node.

7. **No CI/CD, no staging, no rollback.** Every deploy is a manual SSH → `git pull` → `npm build` → `pm2 reload` on the *only* node. A bad build is a production outage with no fast path back. Migrations run synchronously at deploy with raw `addIndex` and no online-DDL strategy.

8. **Ease of use is a first-class scaling lever, not a nice-to-have.** Self-service tenant onboarding, mobile **OTA updates** (so 100k guards aren't stuck on stale native builds), in-app diagnostics, and bulk import are what let you grow without your support team growing linearly. Build these into the roadmap, not after it.

---

## 2) Target Architecture

```
                          ┌──────────── Clients ────────────┐
                          │  CRM (Vite/React)  SuperAdmin    │
                          │  Worker app (Ionic/Capacitor,    │
                          │  native iOS/Android + FCM push)  │
                          └───────────────┬──────────────────┘
                                          │ HTTPS / WSS
                                          ▼
                      ┌───────────────────────────────────────┐
                      │     Cloudflare  (CDN + WAF + DDoS)     │
                      │  static assets, signed-URL media cache │
                      └───────────────────┬───────────────────┘
                                          ▼
                      ┌───────────────────────────────────────┐
                      │   Load Balancer  (ALB / Cloud LB)     │
                      │   TLS term · health checks · WS upgrade│
                      └───────┬───────────────────┬───────────┘
                              ▼                   ▼
              ┌──────────────────────┐   ┌──────────────────────┐
              │  Stateless API tier  │   │  WebSocket / Radio    │
              │  (Docker, autoscaled │   │  tier (socket.io +    │
              │   2..N containers)   │   │  PCM relay, sticky    │
              │  Express, JWT, no    │   │  via LB, Redis adapter)│
              │  local state         │   └──────────┬───────────┘
              └───────┬──────────────┘              │
                      │            ┌────────────────┘
                      ▼            ▼
        ┌──────────────────────────────────────────────────────┐
        │  Redis (managed, HA: ElastiCache/Memorystore + replica)│
        │  socket.io adapter · radio pub/sub · rate-limit store  │
        │  · auth/permission cache · BullMQ queue backend        │
        └───────┬───────────────────────────────────┬───────────┘
                │                                   │
                ▼                                   ▼
   ┌─────────────────────────┐        ┌──────────────────────────────┐
   │  Worker / Jobs tier      │        │  Managed MySQL 8 / Aurora     │
   │  (Docker, separate svc)  │        │  ┌─────────┐  ┌────────────┐  │
   │  BullMQ consumers:       │───────▶│  │ Writer  │─▶│ Read        │  │
   │  DutySync, RadioCheck,   │        │  │ (primary)│  │ replica ×2  │  │
   │  Consigna, ForcedClockOut│        │  └─────────┘  └────────────┘  │
   │  ShiftReminders, Billing,│        │  via RDS Proxy / ProxySQL     │
   │  SeatReconcile, AttendDet│        └──────────────────────────────┘
   └─────────────────────────┘
                │
                ▼
   ┌─────────────────────────┐   ┌──────────────────────────────────┐
   │  Alarm receiver          │   │  Object storage (S3 / GCS)        │
   │  (single fork, TCP/UDP   │   │  selfies, IDs, evidence, radio    │
   │  DC-09/Contact-ID :6543) │   │  audio → served via CDN signed URL│
   └─────────────────────────┘   └──────────────────────────────────┘

  Integrations (called from API + worker tiers, SDKs lazy-loaded):
   Stripe · Meta WhatsApp Cloud · Twilio (SMS/voice) · Firebase FCM · OpenAI
```

### Two concrete deployment options

| | **Option A — Managed PaaS (recommended start; cheaper, less ops)** | **Option B — Kubernetes (when you need fine control)** |
|---|---|---|
| API tier | **Render** / **Railway** / **Fly.io** / AWS App Runner / GCP Cloud Run | EKS/GKE Deployment, HPA on CPU+RPS |
| Worker tier | Same platform, separate service | Separate Deployment |
| Alarm receiver | Fly.io dedicated machine / single ECS task (raw TCP/UDP) | StatefulSet, 1 replica, NodePort/LB for :6543 |
| MySQL | **PlanetScale** or AWS RDS/Aurora MySQL | Aurora (don't self-host DB) |
| Redis | Upstash / ElastiCache | ElastiCache / Memorystore |
| Storage | S3 / GCS / Cloudflare R2 | same |
| CI/CD | GitHub Actions → platform deploy hook | Actions → image → ArgoCD/Helm |

**Decision: start with Option A.** Your team is small, there's no platform engineer, and Cloud Run / Render gets you autoscaling + zero-downtime deploys + managed TLS with near-zero ops. Move to K8s only if/when multi-region or cost at 100k forces it.

---

## 3) What to change and why — mapped to the current setup

| Current reality (file) | Why it breaks at scale | Change |
|---|---|---|
| **Single node, manual `pm2 reload` on `192.168.86.23`** (`ecosystem.config.js` deploy block) | No HA, no rollback, can't fit 100k on 4 cores | Containerize → 2+ stateless replicas behind LB on Cloud Run/Render; CI/CD + staging |
| **Sequelize built with no `pool`** (`models/index.ts`) — `DATABASE_POOL_*` env ignored | ~5 conns/worker → requests queue on acquire and time out before MySQL is stressed | Wire `pool:{max,min,acquire,idle}` from env. **P0, one change.** |
| **Local `/uploads`** (`fileStorage.ts` default `'localhost'`) | App non-stateless; media lost with the box; blocks node #2 | Flip `FILE_STORAGE_PROVIDER=aws/gcp` (providers already exist) → S3/GCS + CDN signed URLs |
| **9 `setInterval` schedulers in `server.ts`** with `findAll({limit:2000})` + N+1 and per-minute all-tenant loops | Steal CPU + the tiny DB pool from live requests; don't scale with tenant count | Extract to a **worker tier** on BullMQ/Redis; bound + index scans, set-based queries |
| **Single MySQL** (`127.0.0.1:3306`), `replicationLag` hardcoded `null` in `SystemHealthService` | One writer = read ceiling + SPOF | Managed MySQL: 1 writer + 2 read replicas via RDS Proxy/ProxySQL; route reads (dashboards, lists) to replicas |
| **Single Redis** — `realtime.ts`/`radioVoice.ts` silently fall back to single-worker if `REDIS_URL` unset | Realtime + radio break across nodes; SPOF | Managed HA Redis; **fail boot if `REDIS_URL` missing in prod** |
| **`authMiddleware` DB hit per request** (`findByToken` + `getPermissionsMapForTenant`) | DB-load multiplier on every call | Short-TTL Redis cache keyed by token + tenant permission map; invalidate on role/token change |
| **In-memory rate limiter** (`apiRateLimiter.ts`, Mongo store commented out) | Limit is per-worker × workers, resets on deploy, unenforceable across fleet | `rate-limit-redis` (Redis already a dep) |
| **`cors({origin:true,credentials:true})`** (`api/index.ts:20`) | Reflects any origin with credentials — cross-origin/JWT leak | Explicit allowlist of the 3 app origins |
| **`databaseMiddleware` swallows init error, calls `next()`** | Opaque 500s / null-deref on DB blip; LB can't detect | Return **503** on init failure (also feeds LB health checks) |
| **`uncaughtException` logs-and-continues** (`server.ts`) | Worker serves in corrupted state; masks failures | In container world, log → exit non-zero → orchestrator restarts; keep handler only to flush logs |
| **97 eager `require('./x')` routes + firebase/twilio/openai/stripe SDKs** → ~175MB/worker, 3245 modules | Caps workers/box, slows reload | Lazy-load heavy SDKs; defer rarely-used route modules |
| **`auditLog` no indexes, JSON `values` blob** (`models/auditLog.ts`); 74 `TEXT` cols incl. `guardShift.punchInPhoto` | High-write table unindexed; risk of base64 media in-row | Add `(tenantId, createdAt)` index; confirm photo columns store **URLs only**, never base64 |
| **No tenant-isolation hook** — every repo hand-writes `where.tenantId` | One forgotten clause = cross-tenant data leak | Add Sequelize `beforeFind`/`defaultScope` enforcing `tenantId` from request context as defense-in-depth |
| **PORT mismatch**: ecosystem says `8080`, `server.ts` defaults `3001`, EADDRINUSE walks +1..+5 | Worker can bind an unexpected port and fall out of nginx upstream | Fix to one canonical port; remove the port-walk in a containerized world (let orchestrator handle conflicts) |

---

## 4) Phased roadmap with exit-criteria

### Phase 0 — "Stabilize now" (1–2 weeks, mostly S effort, no new infra)
**Goal: stop the bleeding and unblock horizontal scale, cheaply.**
- Wire the **Sequelize pool** from env (`models/index.ts`). *(S, P0)*
- **Off-box backups**: automated nightly `mysqldump` + `/uploads` sync to S3/R2, and *test a restore*. *(S, P0)* — even before full migration, this removes the "disk dies = business dies" risk.
- Flip **file storage to S3/GCS** for new uploads; backfill existing later. *(M, P0)*
- **Redis-backed rate limiter** + confirm `REDIS_URL` set in prod. *(S, P1)*
- **CORS allowlist**; `databaseMiddleware` → 503. *(S, P1)*
- Add `auditLog (tenantId, createdAt)` index; audit `punchInPhoto`/TEXT columns for base64. *(S, P1)*
- **Exit criteria:** a tested restore exists; new media in object storage; pool ≥ configured; rate limit shared; a single-node failure is recoverable within hours, not "never."

### Phase 1 — "To ~1k users / production-ready" (3–5 weeks)
**Goal: containerize, get CI/CD + staging, become genuinely stateless.**
- **Dockerize** API + alarm receiver; deploy to Cloud Run/Render with **2 replicas behind LB**. *(XL, P0)*
- **GitHub Actions CI/CD** (build image → deploy) + a **staging** environment + one-command rollback. *(L, P0)*
- **Managed MySQL** (PlanetScale/RDS) + **managed HA Redis**; cut over. *(L, P0)*
- **Auth/permission cache** in Redis. *(M, P1)*
- Backfill remaining media to object storage; serve via CDN signed URLs. *(M, P1)*
- **Exit criteria:** zero local state on app nodes; a bad deploy rolls back in <5 min; killing one app container is invisible to users; deploys are automated.

### Phase 2 — "To ~10k users" (4–6 weeks)
**Goal: separate jobs from requests; kill read amplification.**
- **Worker tier on BullMQ**: migrate all 9 schedulers out of `server.ts`; keep DB row-claims as belt-and-suspenders. *(L, P1)*
- **Read replicas** + route dashboard/list reads to them. *(M, P1)*
- **Fix N+1**: rewrite `securityGuardRepository._fillWithRelations*` as set-based includes/batched queries; `dashboardService` 12-month loops → single `GROUP BY`. *(M, P1)*
- Bound + index scheduler scans; replace `AttendanceDetection` per-shift N+1 with set-based + cursor pagination. *(M, P2)*
- **Tenant-isolation Sequelize hook** as defense-in-depth. *(M, P1)*
- **Exit criteria:** schedulers run off the request path; guard-list and dashboard p95 < 300ms; CPU on app tier driven by real traffic, not jobs.

### Phase 3 — "To 100k users" (ongoing)
**Goal: elasticity, edge, observability, cost control.**
- **Autoscaling** policies (CPU + RPS + queue depth) on API and worker tiers. *(M, P2)*
- **Aurora / DB sharding-by-tenant** evaluation if writer saturates; consider tenant-tier separation for whale tenants. *(L, P2)*
- **Edge WAF + bot/abuse protection** (Cloudflare) tuned. *(M, P2)*
- Lazy-load heavy SDKs; split route modules to shrink footprint. *(M, P2)*
- **Persisted observability**: ship `slowQueryMonitor`/`workerMetrics` to a real APM (Datadog/Grafana Cloud) instead of per-worker ring buffers; alerting + SLOs. *(M, P2)*
- **Exit criteria:** load test sustains 100k concurrent-ish (clock-ins, polls, sockets) at target latency; autoscale proven; DB writer < 60% sustained.

---

## 5) Consolidated, de-duplicated prioritized backlog

| # | Item | P | Effort | Phase |
|---|---|---|---|---|
| 1 | Wire Sequelize `pool` from `DATABASE_POOL_*` env in `models/index.ts` | **P0** | S | 0 |
| 2 | Off-box automated backups (DB + uploads) + tested restore | **P0** | S | 0 |
| 3 | Move file storage to S3/GCS (flip `FILE_STORAGE_PROVIDER`) + CDN | **P0** | M | 0→1 |
| 4 | Containerize API + alarm receiver | **P0** | XL | 1 |
| 5 | CI/CD (GitHub Actions) + staging env + rollback | **P0** | L | 1 |
| 6 | Managed MySQL (writer + replicas) cutover | **P0** | L | 1 |
| 7 | Managed HA Redis; fail boot if `REDIS_URL` unset in prod | **P0** | M | 1 |
| 8 | Redis-backed rate limiter (`rate-limit-redis`) | P1 | S | 0 |
| 9 | CORS explicit allowlist (drop `origin:true`+credentials) | P1 | S | 0 |
| 10 | `databaseMiddleware` returns 503 on DB-init failure | P1 | S | 0 |
| 11 | `auditLog` index `(tenantId, createdAt)`; audit TEXT/base64 photo cols | P1 | S | 0 |
| 12 | Cache auth/permission lookups in Redis (short TTL) | P1 | M | 1 |
| 13 | Extract schedulers to worker tier on BullMQ | P1 | L | 2 |
| 14 | Fix N+1: `securityGuardRepository` + `dashboardService` GROUP BY | P1 | M | 2 |
| 15 | Route read queries to MySQL read replicas | P1 | M | 2 |
| 16 | Tenant-isolation Sequelize `beforeFind`/`defaultScope` hook | P1 | M | 2 |
| 17 | Bound/index scheduler scans; AttendanceDetection set-based + cursor | P2 | M | 2→3 |
| 18 | Autoscaling policies (CPU/RPS/queue depth) | P2 | M | 3 |
| 19 | Lazy-load firebase/twilio/openai/stripe SDKs; split routes | P2 | M | 3 |
| 20 | Edge WAF / bot protection (Cloudflare) | P2 | M | 3 |
| 21 | Persisted APM + SLOs/alerting (replace ring buffers) | P2 | M | 3 |
| 22 | Fix PORT mismatch (8080 vs 3001); drop EADDRINUSE port-walk | P2 | S | 1 |
| 23 | `uncaughtException` → exit non-zero under orchestration | P2 | S | 1 |

---

## 6) "Ease of use" track

This is what keeps growth from being throttled by your support team. Concrete, codebase-specific:

- **Self-service tenant onboarding (CRM + SuperAdmin):** a guided wizard — company → first admin → branding → import guards → Stripe seat plan ($5/user/mo) — so a new security company is live without a human. Leverage the existing `tenantInvitations` flow and the `/import` endpoints (already rate-limit-exempt) for bulk guard upload via CSV with validation preview.
- **Mobile OTA updates (worker-app, Ionic/Capacitor):** add **Capacitor Live Updates / Appflow** (or Capgo) so JS bundle fixes ship to 100k guards in hours without an App Store/Play review cycle. Today a bad native build = weeks of stragglers on stale code. This is the single biggest mobile-scale lever.
- **In-app diagnostics for guards:** a one-tap "connection/clock-in self-check" that verifies FCM token, location permission, server reachability, and last-sync — cutting "my clock-in didn't work" tickets, which dominate at guard scale.
- **Robust offline + retry in the worker app:** queue clock-in selfies/incidents locally and sync when connectivity returns (guards work in poor-signal sites). Pairs naturally with object-storage direct-upload (presigned URLs) to offload media from the API tier.
- **Status page + graceful degradation:** when OpenAI is out of quota (radio transcription) or Twilio is suspended/unfunded, the CommunicationService already cascades push → WhatsApp → SMS → email; surface that fallback state in-app and on a public status page instead of silent failure.
- **SuperAdmin operational console:** make `SystemHealthService` real — show replication lag, queue depth, slow-query feed (from `slowQueryMonitor`), per-tenant seat/billing health — so the platform owner self-serves diagnosis.
- **Admin bulk operations + saved views:** bulk shift assignment, saved filters on the guard list (which is the heaviest page), and CSV export — the daily workflows for a 1,000-guard tenant admin.
- **Localization & timezone correctness:** Sequelize `timezone:'+00:00'` is set, but ensure all guard-facing times render in the tenant's local zone — critical across LatAm timezones for shift/attendance accuracy.

---

## 7) Top risks + mitigations, and cost envelope

### Top risks
| Risk | Mitigation |
|---|---|
| **Single-box data loss (highest, today)** | Phase 0 off-box backups + tested restore *before* any other work; then managed DB + object storage |
| **Pool fix exposes MySQL as the next bottleneck** | Land pool fix *with* slow-query monitoring on; have read replicas ready (Phase 2) |
| **Migrations run synchronously at deploy** (raw `addIndex`, 198 files, no online DDL) | Use online-DDL (pt-online-schema-change / PlanetScale branch deploy); gate migrations in CI against staging first |
| **Cross-tenant leak** (manual `tenantId` in ~100 repos, no hook) | Enforcement hook (#16) + automated test asserting no query runs without tenant scope |
| **Alarm receiver is unscalable by design** (single TCP/UDP socket) | Keep as a single dedicated instance with health-checked auto-restart; it's low-throughput, so this is acceptable — just make it HA-restartable, not replicated |
| **Big-bang migration outage** | Phased cutover, staging rehearsal, feature-flag DB/Redis endpoints, rollback runbook |
| **Cost surprise at scale** | Start PaaS (pay-per-use), set autoscale ceilings + billing alerts, CDN-cache media aggressively |

### Rough monthly cloud cost envelope (USD, PaaS Option A; ±50%)
| Component | ~1k users | ~10k users | ~100k users |
|---|---|---|---|
| API + worker compute (Cloud Run/Render, autoscaled) | $80–150 | $400–800 | $3k–6k |
| Managed MySQL (writer +replicas) | $60–120 | $300–600 | $2k–4k |
| Managed Redis (HA) | $30–60 | $100–200 | $500–1k |
| Object storage + CDN egress (media-heavy: selfies/audio) | $20–50 | $150–400 | $1.5k–3k |
| Integrations (Twilio/WhatsApp/FCM/OpenAI — usage-based) | $50–200 | $500–2k | $5k–20k+ |
| Observability/APM, backups, logs | $30–80 | $150–400 | $1k–2k |
| **Total infra (excl. usage-based integrations)** | **~$250–500/mo** | **~$1.5k–3k/mo** | **~$10k–18k/mo** |

Integration/messaging spend will dominate at 100k and is driven by product behavior (how chatty push/SMS/WhatsApp are) — design notification batching and prefer free FCM push over paid SMS to control it.

---

**Bottom line:** Three Phase-0 changes — wire the pool, get backups off the box, move uploads to object storage — remove existential risk and unblock everything for almost no cost. Then containerize + CI/CD (Phase 1) to make the platform survivable and deployable, split jobs + replicas (Phase 2) to make it fast, and autoscale + observe (Phase 3) to reach 100k. The storage and Redis-adapter providers already exist in your code; most of the early wins are wiring config that's currently dead, not building new systems.