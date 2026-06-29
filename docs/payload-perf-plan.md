# C-Guard Pro API — Enterprise-Readiness Plan: List/Find Endpoint Payload & Query Efficiency

## 1. Executive Summary

The over-fetching across the API is **severe and systemic, not incidental**. Across 19 domain audits covering ~110 list/find endpoints, the same fingerprint recurs in nearly every CRUD-Builder-generated repository: a detail-oriented `_fillWithRelationsAndFiles` helper is reused **per row** inside `findAndCountAll`. This single design decision produces the bulk of the platform's scaling risk.

**The dominant root cause** is the generator's `_fillWithRelationsAndFilesForRows` → `_fillWithRelationsAndFiles` pattern. It was written for the *detail* surface (one record, where loading every relation + signing every file is correct) and then blindly reused for the *list* surface. The result is a compounding three-way failure on the same endpoints:

- **N+1 queries** — each row fires 2–8 follow-up queries (lazy getters, `findByPk`, `file.findAll`).
- **Over-fetch** — `SELECT *` with no `attributes`, shipping full related objects (station with `geofencePolygon`/`stationSchedule` TEXT blobs, full user rows, JSON columns) when the UI renders a single name.
- **Signed-URL waste** — `FileRepository.fillDownloadUrl` runs a storage-signing round trip per row, on CRM list surfaces that render **no images at all**.

**The scaling math is alarming.** Because most CRM list repos default `limit = 0` (→ `undefined` → no `LIMIT` clause) and the frontend frequently passes `limit=999/1000/9999` or *no limit at all*, the N+1 runs over the **entire tenant table**, not one page:

- `securityGuardRepository.findAndCountAll` (securityGuardRepository.ts:739): CRM passes no limit → **~7N queries + ~3N signed URLs** across every guard. At 500 guards that's **~3,500 queries + ~1,500 storage signings per single page load**, to render id/fullName/email/phone/status.
- `stationRepository.findAndCountAll` (stationRepository.ts:366): frontend sends `limit=999` → **~8N queries**; ~999 stations ≈ **~8,000 queries for one list render**.
- `GuardShiftRepository.findAndCountAll` (guardShiftRepository.ts:350) backs **both** the CRM Nómina list **and** the worker-app mobile `/guard-shift` list, plus `payrollSummary` at `limit:100000` — ~3 queries/row + base64 selfie blobs on every row.
- `performanceLeaderboard` (performanceLeaderboard.ts:27) recomputes a 15–20-query per-guard algorithm for up to 200 guards → **~3,000–4,000 queries per analytics page-load**.

**At 100k users with a constrained DB pool**, this is an existential risk. The connection pool is already noted as capped (~5 per the enterprise-architecture memory). A handful of these list/export calls executing thousands of serialized queries will **saturate the pool, starve every other request, and cascade into timeouts**. The export paths (`securityGuardService.exportToFile` at :964 with `limit:0`, `UserService.exportToFile` with `limit:0`) are the most dangerous single calls — unbounded N+1 over the whole table that can exhaust the pool outright.

**The good news:** the *modern* code generation (`messageService`, the hand-written `guard/me/*` handlers, `task/approvals`, the superadmin billing/users services) is genuinely lean — scoped `attributes`, single grouped aggregates, clamped limits, keyset pagination. The fix is not invention; it is **propagating the patterns the team already writes well** into the legacy repos, and killing the per-row `_fill` on list paths.

---

## 2. Systemic Anti-Patterns (ranked by prevalence)

### A. Per-row `_fill` N+1 — **~25 endpoints** (the dominant offender)
**What:** `findAndCountAll` maps every row through `_fillWithRelationsAndFiles`, which issues lazy getters / `findByPk` / `file.findAll` per row — often on top of an `include` that *already* JOINed the data and then threw it away.

**Confirmed instances:** visitorLog (visitorLogRepository.ts:690), securityGuard (:1279), incident (incidentRepository.ts:725 — double-fetches the JOINed relations), user (userRepository.ts:1634 — re-fetches `getTenants`+`settings`+avatars already eager-loaded), clientAccount (:906), businessInfo (businessInfoRepository.ts:744 — *triple* N+1 with a controller `findById` loop + 2 raw counts), station (stationRepository.ts:633 — 6 getters/row), guardShift (guardShiftRepository.ts:705), certification (:537), notification (notificationRepository.ts:493), task (taskRepository.ts:532), memos (:497), service (serviceRepository.ts:649), vehicle (:191), insurance (:480), tutorial (:426), videoTutorialCategory (:412), patrol/patrolCheckpoint/route (patrolRepository/routeRepository), billing (billingRepository.ts:518), kpi (per-row `report.count`, kpiRepository.ts:191), bannerSuperiorApp (:439), inventoryItem (:209), guardMePatrols (guardMePatrols.ts:39), requestRepository (:714 — latent/dead), radioCheckService.getConsole (:417), superadmin listTenants (per-tenant count) + getTenantDetail (count-every-model loop).

**Standard fix:** Delete `_fillWithRelationsAndFilesForRows` from the list path. Use a single `include` with scoped `attributes`; replace per-row counts with one grouped `COUNT … GROUP BY`; batch any needed file rows with one `file.findAll WHERE belongsToId IN (...ids)`.

### B. Over-fetch: `SELECT *` + full related objects — **~30+ endpoints (near-universal)**
**What:** No `attributes` on the root model or the includes, so full rows + full related objects flow to the wire even when the UI shows one name.

**Worst:** any include of `station` ships `geofencePolygon`/`stationSchedule` TEXT (shift, guardShift, task, incident, inventoryAssignment, additionalService, visitorLog, tagScans, operations/upcoming-services); `memos` includes the full `user` createdBy object incl. `password`/token columns (memosRepository.ts:275 — masked by getters but still a `SELECT *`); invoice/estimate ship full `clientAccount` + `businessInfo` (description TEXT 5000, serviceConfig JSON).

**Standard fix:** Mandatory `attributes` whitelist on every root query and every include — id + the display fields only.

### C. Blob / heavy-field shipping — **~20 endpoints**
**What:** TEXT/JSON blobs serialized into list payloads the UI never renders: `station.geofencePolygon`/`stationSchedule`; `guardShift.punchInPhoto`/`punchOutPhoto` (base64 selfies), `deviceInfo`, `sessions`; invoice/estimate `items`/`payments` JSON; `incident.content`/`internalNotes`/`actionsTaken`; `communicationLog.providerResponse`; `alarmSignal.raw`; `trainingCourse.certificateTemplate`/`htmlContent`; `deviceIdInformation.pushToken`/`apnsToken` (secret leak into the DB read).

**Standard fix:** Exclude blobs via the `attributes` whitelist; expose them only on the detail (`findById`) fetch or a lazy row-expand.

### D. Signed-URL waste — **~16 endpoints**
**What:** `FileRepository.fillDownloadUrl` (storage signing round-trip) executed per row on surfaces that render no image: visitorLog CRM list, securityGuard list (3 files/row: profile + credential + recordPolicial), incident list, clientAccount (logo+place), businessInfo, certification (image+icon), notification, task (2 files/row), memos (PDF), service (icon+images), vehicle, insurance, inventoryItem, billing, user (avatars).

**Standard fix:** Never sign in a list path. Sign only on detail, or batch-sign only when a surface (worker visitor list, guardLicense page, order-completions evidence) actually renders thumbnails.

### E. Unbounded pagination — **~35 endpoints (near-universal)**
**What:** `limit = 0` → `undefined` → no `LIMIT` clause; no max clamp; frontend passes `limit=999/1000/9999` or omits it entirely. Export paths hardcode `limit:0`/`limit:100000`.

**Standard fix:** Default 25, hard max 100 clamped server-side in every list repo. Dedicated lean streaming/batched query for exports. Cursor pagination for unbounded-growth tables (guardShift, tagScan, inventoryHistory, video clips/events, alarm cases, invoices).

### F. Missing indexes (hypotheses to verify) — **~15 endpoints**
**What:** Filtered/ordered columns lacking composite indexes: most models only declare `(importHash, tenantId)` unique. Hot gaps: `shift(tenantId,startTime)`/`(tenantId,guardId,startTime)`; `guardShift(tenantId,punchOutTime)`; `tagScan(scannedAt)`/`(stationId)`; `station(tenantId,postSiteId)`/`(tenantId,createdAt)`; invoice/estimate `(tenantId,clientId)`/`(tenantId,postSiteId)`/`(tenantId,createdAt)`; visitorLog/incident `(tenantId,createdAt)`+filters; `radioCheckEntry(tenantId,stationId,createdAt)`; `deviceIdInformation(tenantId,userId)`.

**Standard fix:** Add composite indexes on `(tenantId, <filter>, <order>)`; replace leading-wildcard `iLike '%q%'` filters with prefix-anchored or full-text where they back autocomplete.

### G. Envelope inconsistency — **~10 endpoints**
**What:** Three+ shapes coexist: `{rows,count}`, bare array (`tenantUserClientAccounts`, autocomplete), `{shifts,timeOff,freeDays}`, `{rows,nextCursor}`. Some `{rows, count: rows.length}` report page size as total (clock-in/out requests, userList where JS filtering corrupts `count`).

**Standard fix:** One documented `{rows, count, page, limit, totalPages}` envelope for offset lists; `{rows, nextCursor}` for cursor lists; `[{id,label}]` for autocomplete.

---

## 3. The Enterprise Standard (adoptable policy + checklist)

**Policy: every list endpoint must satisfy this checklist before merge.**

1. **List-vs-detail projection.** List endpoints return a *lean shape* — only the columns the table renders. `findById`/detail endpoints may load full relations + sign files. The two MUST NOT share `_fillWithRelationsAndFiles`.
2. **JOIN-with-attributes, never per-row.** Relations come from a single `include` with an explicit `attributes` whitelist (`id` + display name). Counts come from one grouped `COUNT … GROUP BY`. Zero `findByPk`/`getX()`/`file.findAll` inside a row map.
3. **Mandatory `attributes` on root + every include.** No `SELECT *` in a list. Blobs (geofencePolygon, stationSchedule, base64 photos, items/payments JSON, providerResponse, raw tokens) are excluded by default.
4. **Mandatory pagination.** `limit` default **25**, hard max **100**, clamped *server-side* (callers cannot override the max). Exports use a dedicated lean+batched/streamed query, never `limit:0` over `_fill`. Unbounded-growth tables (guardShift, tagScan, inventoryHistory, invoices, video events/clips, alarm cases) offer **keyset/cursor** pagination.
5. **File URLs lazy/on-demand.** Never sign in a list path. Sign on detail, or batch-sign with one `file.findAll WHERE belongsToId IN (...)` only when a surface renders thumbnails (worker visitor list, guardLicense, order-completions).
6. **One envelope.** Offset lists: `{ rows, count, page, limit, totalPages }`. Cursor lists: `{ rows, nextCursor }`. Autocomplete: `[{ id, label }]`. `count` is always the true total.
7. **Indexing rule.** Any column used in `where`/`order` gets a composite index `(tenantId, <filter>, <order>)`. Autocomplete name filters use prefix-anchored matches.

**Reusable helper (sketch) — make lean the default:**

```ts
// listQuery.ts — one entry point every list repo calls
const MAX_PAGE = 100, DEFAULT_PAGE = 25;

export async function leanList<M>(model, {
  where, attributes, includes = [],   // includes: {model, as, attributes} — attributes REQUIRED
  order = [['createdAt', 'DESC']],
  limit, offset = 0,
  cursor,                              // optional keyset { column, value }
}) {
  const lim = Math.min(Number(limit) || DEFAULT_PAGE, MAX_PAGE);
  // attributes is required -> lint/throw if any include lacks `attributes`
  const w = cursor ? { ...where, [cursor.column]: { [Op.lt]: cursor.value } } : where;
  const { rows, count } = await model.findAndCountAll({
    where: w, attributes,
    include: includes,                 // scoped attributes only; NO lazy getters after
    order, limit: lim, offset,
    distinct: true, subQuery: false,
  });
  return cursor
    ? { rows, nextCursor: rows.at(-1)?.[cursor.column] ?? null }
    : { rows, count, page: Math.floor(offset / lim) + 1, limit: lim,
        totalPages: Math.ceil(count / lim) };
}

// Batch file signing ONLY when a surface renders thumbnails — one query, not N:
export async function attachSignedFiles(rows, { column, idKey = 'id' }) {
  const ids = rows.map(r => r[idKey]);
  const files = await db.file.findAll({ where: { belongsToId: ids, belongsToColumn: column } });
  const byId = groupBy(files, 'belongsToId');
  await Promise.all(rows.map(r => FileRepository.fillDownloadUrl(byId[r[idKey]] ?? [])));
  return rows; // signed in ONE batch pass
}
```

Adopt `leanList` as the template the `messageService`/`task/approvals` handlers already embody. New endpoints get pagination, projection, and the envelope for free; a lint rule rejects any `include` without `attributes` and any list path that calls `_fillWithRelationsAndFiles`.

---

## 4. Prioritized Remediation Hit-List

### TIER 0 — Pool-killers (do first; can take down the box at scale)
| Endpoint | Problem | Fix | Effort |
|---|---|---|---|
| `securityGuardRepository.findAndCountAll` :739 + CRM no-limit (SecurityGuardsPage.tsx:348) | ~7N q + 3N signs over **all** guards | Lean list path (attributes, drop 3 file signs + memos/requests/tutoriales, single tenantUser JOIN), server-side limit, FE sends limit/offset | L |
| `securityGuardService.exportToFile` :964 (`limit:0`) | Unbounded N+1 over whole table for 9 scalars | Dedicated lean `findAll` (attributes + 1 user JOIN), no `_fill`, batch/stream | M |
| `stationRepository.findAndCountAll` :366 + `limit=999` (Stations.tsx:88, PostSiteLayout.tsx:59) | ~8N q; ~8,000/render | Lean path: attributes (drop geofence/schedule), replace 6 getters with grouped COUNTs, clamp limit | L |
| `GuardShiftRepository.findAndCountAll` :350 (**CRM + worker-app mobile**) | ~3N q + base64 selfie blobs/row; backs payrollSummary `limit:100000` | attributes on includes + root (drop punch photos/sessions/deviceInfo), drop `getPatrolsDone`/`getDailyIncidents` from list | M |
| `performanceLeaderboard` :27 | 15–20 q × 200 guards = ~3–4k q/load | Batched aggregate queries or cached/materialized nightly score (kpiWorker exists); compute only rendered guards | L |
| `attendanceAdminService.payrollSummary` :534 | `limit:100000` + inherited 2N enrich | Own lean query → push sums into SQL `GROUP BY` | M |
| `UserService.exportToFile` (`limit:0`) + `userRepository.findAndCountAll` :915 | 3N+1 N+1 (re-fetches already-JOINed tenants+settings+avatars), FE `limit=999/1000` | Drop `_fill` from list (reuse existing include), drop avatar signing, trim `settings` blob, attributes, clamp; lean export query | M |

### TIER 1 — Heavy CRM lists (high payload + N+1)
| Endpoint | Fix | Effort |
|---|---|---|
| `businessInfoRepository.findAndCountAll` :365 (triple N+1 + controller `findById` loop businessInfoList.ts:85 + 2 dead raw counts) | Drop `_fill`, scoped clientAccount include, delete controller loop + counts, attributes, clamp | M |
| `visitorLogRepository.findAndCountAll` :524 (canonical exemplar) | Single include w/ scoped attributes, batch file lookup, sign only on worker surface, clamp | L |
| `incidentRepository.findAndCountAll` :361 (double-fetch) | Use eager includes (drop `_fill`), scoped attributes, dedupe station include, sign only on detail, clamp | M |
| `clientAccountRepository.findAndCountAll` :565 | Drop per-row category+logo+place signing, attributes, clamp | M |
| `invoice` :197 / `estimate` :147 lists | attributes (drop items/payments/notes), lean client+site includes, clamp, indexes; fix `estimateService.create` to `SELECT MAX` | M |
| `siteTourService.listTagScans` :340 (hot rondas surface, `limit=1000`) | attributes on tagScan + all includes (drop station blobs), default 200/max 500, remove per-request `describeTable` | M |
| `taskRepository` :296 / `memosRepository` :266 | Drop file signing from list, scoped includes (memos: never full user), clamp | M |
| `certificationRepository.findAndCountAll` :305 | Batch/eager file load, sign only rendered thumbnail, attributes, clamp | M |
| `notificationRepository.findAndCountAll` :271 | Includes for deviceId+image, batch-sign or skip, attributes, clamp | M |
| `serviceRepository.findAndCountAll` :445 (MobilPage no-limit, 2 signs/row) | Drop file signing from list, server-side clamp, attributes | M |
| `inventoryHistoryRepository.findAndCountAll` :299 (4 full-table joins incl. base64 blobs, unbounded) | attributes on all 4 includes (exclude guardShift photo blobs), default 25/max 200, indexes | M |
| `billingRepository.findAndCountAll` :266 | `bill` include (drop per-row `getBill`), attributes, skip signing, clamp | M |

### TIER 2 — Worker-app mobile reads (high frequency, lower per-call cost)
| Endpoint | Fix | Effort |
|---|---|---|
| `guardMe` dashboard :13 (most-polled call) | attributes on activeClockIn (drop punch photos/deviceInfo/IPs), memoize/skip `fillDownloadUrl` on poll | S |
| `guardMePatrols` :28 | Replace per-row `findByPk`+`count` with one include + one grouped COUNT | M |
| `guardMePerformance` / `GuardPerformanceService` :245 | attributes on the period `guardShift.findAll` (drop photo blobs); `Promise.all` independent counts | S |
| `guardMeTeam` :76 (unbounded active scan) | Push postSite filter into SQL + safety limit; index `guardShift(tenantId,punchOutTime)` | M |
| `trainingEnrollmentService.myEnrollments` :71 (hidden write-amp N+1 on a GET) | Move template materialization out of GET hot path; scope course include | M |

### TIER 3 — Quick wins (mostly S — attributes + clamp on lighter/latent surfaces)
`vehicle` (:191 drop list image sign), `inventoryItem` (:209 drop list file sign), `inventoryAssignment` (:164 station attributes), `additionalService`/`insurance` (attributes+clamp), `completionOfTutorial`/`tutorial`/`videoTutorialCategory` (scoped includes, drop per-row video getters), `deviceIdInformation` (:237 exclude pushToken/apnsToken, clamp), `radioCheckService.getConsole` (:410 batch guards + latest-entry), `communicationLog` (exclude providerResponse), all alarm/video lists (caseList/panelList/signalList/clipList/eventList/cameraList — add limit clamp + attributes, **strip `password` from videoCamera→device include**, cameraList.ts:27), `superadmin listTenants` (grouped seat count) + `getTenantDetail` (curated count allow-list), `reportRepository` (:353 drop content+station blobs, clamp), `schedulerOverview` (:316 attributes on shift.findAll), `shiftRepository` (:289 attributes on station/guard includes, clamp).

**Cross-cutting quick win:** introduce the shared `MAX_PAGE_SIZE` clamp in `leanList`/handlers (`Math.min(limit, 100)`) — defends every list against the frontend's `limit=999/9999` callers at once.

---

## 5. Sequenced Rollout

**Phase 0 — Guardrails (1–2 days, near-zero risk, broad protection).**
- Land the shared `leanList`/`MAX_PAGE_SIZE` helper + the batch `attachSignedFiles`.
- Apply the **server-side max-limit clamp (100)** in the base list repo path. This alone neutralizes every `limit=999/1000/9999` frontend caller and caps unbounded scans *without touching per-endpoint logic*.
- Add a lint/CI rule: list paths may not call `_fillWithRelationsAndFiles`; every `include` must declare `attributes`.
- **Verify:** for a tenant with N>500 guards/stations, confirm a list call now returns ≤100 rows (assert `LIMIT` present in SQL log).

**Phase 1 — Stop the pool-killers (Tier 0).**
Lean-path the export endpoints first (they are the single biggest pool-exhaustion risk and are easy to isolate — a dedicated query, no shared `_fill`), then securityGuard/station/guardShift/performance lists.
- **Verify:** enable Sequelize `benchmark`/`SLOW_QUERY_MS` (already wired per observability memory). Capture **queries-per-request before/after** via the slow-query page and request-scoped query counters. Target: securityGuard list from ~3,500 → ≤3 queries; station list from ~8,000 → ≤4; guardShift list from 3N → 2. Capture **response bytes** (drop base64 selfie blobs → expect 10–100× payload reduction on guardShift/Nómina).

**Phase 2 — Heavy CRM lists (Tier 1).**
Roll the `_fill`-removal pattern across visitorLog/incident/clientAccount/businessInfo/invoice/estimate/tagScans/task/memos/certification/notification/inventoryHistory/billing. These share one mechanical transform (delete `_fill`, scope includes, batch files) — do them in a batch PR per repo with a shared review checklist.
- **Verify:** per endpoint, assert query count is O(1) (≤3), no `fillDownloadUrl` in list SQL traces, and that the frontend pages still render every consumed field (the audits enumerate the exact consumed columns — diff the response against them).

**Phase 3 — Worker-app mobile reads (Tier 2).**
Highest-frequency calls; smaller blast radius per call but multiply by mobile poll volume. Drop blobs from `guardMe`/`guardMePerformance`, fix the `guardMePatrols` N+1, push `guardMeTeam` filter into SQL, move `myEnrollments` write-amp off the GET path.
- **Verify:** measure p95 latency + bytes on the mobile dashboard poll; confirm signed-URL signing no longer fires on every poll.

**Phase 4 — Indexes + envelope normalization + Tier 3 quick wins.**
- Add the composite indexes (Phase 1–3 will have revealed the real filesort/scan hotspots via the slow-query page — index against *measured* plans, not just hypotheses). Run `EXPLAIN` on the top filtered/ordered queries.
- Normalize envelopes to the single `{rows,count,page,limit,totalPages}` shape; fix `count` correctness in `userList` (JS filter corrupts count → push role exclusion into SQL) and the clock-in/out request lists.
- Sweep Tier 3 (attributes + clamp + **secret-stripping** on videoCamera/deviceIdInformation), the superadmin count N+1s, and the dashboard/overview aggregation fan-outs (collapse 12-month loops into `GROUP BY`, add short per-tenant cache).
- **Verify:** `EXPLAIN` shows index usage (no `filesort`/full scan) on the hot queries; superadmin tenant list/detail drop from N+ counts to ≤3.

**Guiding principle for the whole rollout:** lowest-risk-highest-impact first means **Phase 0's global clamp** (caps the worst-case blast radius platform-wide in hours) before any per-endpoint surgery, then the **export/Tier-0 pool-killers** (most likely to actually take down production), then the mechanical `_fill` removals. Every change is verified by the same two metrics: **queries-per-request** (Sequelize benchmark / slow-query page) and **response payload bytes** — both already observable via the existing monitoring stack.