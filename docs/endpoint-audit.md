# C-Guard Pro — Backend Endpoint Audit: Consolidated Review

**Scope:** Read-only audit of the backend (`/Users/mike/cguard-pro/backend`), admin CRM, and worker-app, consolidated from 10 domain auditors. Findings cite `file:line`. No live endpoints were called and no files were modified.

---

## 1. Executive Summary

Overall the codebase is **structurally sound but has several critical isolation and integrity holes** that must be closed before any scale-up. The "happy path" engineering is good: most handlers follow the intended shape (try/catch → `ApiResponseHandler.error`, `PermissionChecker`, tenant-scoped repositories, `lodash.pick` against mass-assignment), and the classic generated CRUD entities (inventory, task, memos, invoice, estimate, station, businessInfo, category) are healthy and tenant-scoped.

The risk is concentrated in **hand-written, newer modules** (the `siteTour`/ronda engine, `tenantUserClientAccounts`, `clientAccount/*` sub-resources, the assigned-guards SQL endpoints, `inventoryAssignment`) and in the **bulk scheduling paths**. The five biggest risks:

1. **Cross-tenant data dump with no auth at all** — `tenant_user_client_accounts` CRUD is completely ungated and unscoped.
2. **Unauthenticated cross-tenant guard PII leak** — `/security-guard/public` with an id fallback and no tenant constraint.
3. **Cross-client leakage within a tenant** — multiple `clientAccount/*` and assigned-guards endpoints trust a URL-supplied id with no ownership check, letting a customer read other clients' post sites, guard rosters, metrics, and invoices.
4. **Invariant 4 (no double-booking) is effectively unenforced** — the only real overlap check lives on the manual single-shift path; all bulk/generated/adhoc/clock-in paths bypass it, and there is no DB exclusion constraint.
5. **Systemic error-handling leak** — a recurring pattern of `throw new Error('...')` (no `.code`) surfaces as HTTP 500 with the raw internal message, breaking client error parsing and leaking internals.

---

## 2. Status of the 4 Invariants

### Invariant 1 — Professional error handling everywhere: **AT RISK**
The baseline shape is followed in the large majority of handlers, but there are systemic gaps:
- **No terminal Express error middleware** (`src/api/index.ts:332-345`): only a JSON-parse handler exists; an async handler that throws without its own try/catch never responds.
- **Plain `Error` → HTTP 500 + raw message leak**, repeated across domains: guard/user/invite (`securityGuardInvite.ts`, `securityGuardPublicCreate.ts`, `userResendInvitation.ts`), financial (`paymentService.ts:16,45`, `invoiceService.ts:499,242,237`, `estimateService.ts:178,287,321,327`), siteTour (`siteTour.ts:130,155,171,311,325,338`), messaging (`messageEndpoints.ts`, `groupEndpoints.ts`), `patrolConfirmInventories.ts:32,86-88`, `postSiteRemoveAssignment.ts:15`. Root cause: `ApiResponseHandler.error` only structures codes 400/401/403/404 (`apiResponseHandler.ts:24,85-86`).
- **Several handlers bypass `ApiResponseHandler` entirely** — `siteTour.ts` uses `next(err)`; `shiftAssign.ts:20-22` and `schedulingEndpoints.ts:121,229,849` return raw `res.status(...).json`.

### Invariant 2 — Worker-app routes (`src/api/guard/*`) full CRUD, no duplication: **AT RISK**
CRUD coverage is complete and most create paths dedup correctly (clock-in, order-complete, messages via `clientMsgId`, backup-volunteer, memo-accept, tag-scan, device-token). But:
- **`guardMeTimeOffCreate.ts:36-47`** has no dedup → double-submit inserts duplicate pending requests.
- **`guardMeDeviceToken.ts:36-49`** and **`guardDeviceService.ts:53-80`** are non-atomic find-then-create with no unique constraint → concurrent registrations duplicate device rows (also undermines the anti-buddy-punching device binding).
- The isolation/overlap defects below (clock-in, patrol, incident-create) also live in `guard/*`.

### Invariant 3 — Client can access ALL its own sitios/stations but is ISOLATED to only its own: **FAILING**
Multiple concrete, bypassable leaks:
- `tenantUserClientAccounts.ts:5-26` — **cross-tenant** dump + arbitrary mutation, no auth/scope/permission.
- `securityGuardPublicFind.ts:74-110` — **unauthenticated cross-tenant** guard PII.
- `tenantFind.ts:4-23` — any authenticated user reads **any tenant's** full record.
- `clientAccountPostSites.ts:31`, `clientAccountGuards.ts:14`, `clientAccountOverview.ts:11`, `businessInfoAutocomplete`/`businessInfoExport`, `postSiteAssignedGuards.ts`/`stationAssignedGuards.ts`/`postSiteStationAssignedGuards.ts`, `invoiceByClient.ts:13-27` — **cross-client within a tenant**: URL-supplied id with no ownership check.
- `siteTourService.ts:68`, `guardMePatrolStart.ts:37-39`, `inventoryAssignmentRepository.ts:14-34`, `routeRun`/`stationOrder` — cross-tenant via unscoped FK/tag lookups.

### Invariant 4 — No guard in two overlapping shifts at once: **FAILING**
The only real overlap check (`ShiftService._assertNoGuardOverlap`, `shiftService.ts:25-58`) runs **only** on manual single-shift create/update. Every other path bypasses it:
- **Adhoc assignments** (`assignmentService.ts:62-122`, overlap block inside `if (!isAdhoc)`), reachable via `postSiteAssignGuard.ts:74-144` when the station has no positions.
- **Bulk/generated shifts** (`shiftGenerationService.ts:439`, `scheduleProposalService.ts:321-337`, `schedulingEndpoints.ts:713-719`).
- **`publishProposal`** ships schedules it itself flagged as double-bookings (`scheduleProposalService.ts:284-292`).
- **Worker-app clock-in** (`guardMeClockIn.ts:222-239`) allows two concurrent OPEN sessions at different stations.
- No DB-level exclusion constraint exists; the unique index only blocks exact `(guard,station,start,end)` duplicates.

---

## 3. Prioritized Findings

> Overlapping findings deduped. The adhoc-overlap defect was reported by both the scheduling and postsite auditors and is merged. The patrol tag-scan / unscoped tour-assignment defect was reported by both worker-app and field-ops auditors and is merged.

### CRITICAL

**C1. `tenant_user_client_accounts` CRUD — no auth, no tenant scope, no permission, no try/catch**
`src/api/tenantUserClientAccounts.ts:5-26` (routed at `src/api/index.ts:324-326`).
`listTenantUserClientAccounts` does `findAll()` with no `where`, dumping every guard↔client pivot row across **all tenants**. `create` spreads raw `req.body` (mass-assignment) linking any guard to any client in any tenant; `delete` destroys any row by id. `authMiddleware.ts:40` calls `next()` even with no token, so these run unauthenticated.
**Fix:** mount under `/tenant/:tenantId/...` behind tenant middleware; add `PermissionChecker.validateHas(clientAccountEdit)`; scope list/delete by joining to `req.currentTenant`; whitelist + validate that `tenantUserId`/`clientAccountId` belong to the tenant; wrap in try/catch. Consider removing entirely in favor of `CustomerIdentityService.provisionAdditionalAccess`.

**C2. Unauthenticated cross-tenant guard PII leak via `/security-guard/public`**
`src/api/securityGuard/securityGuardPublicFind.ts:74-110` (route `index.ts:12-15`).
Reachable with no token. With `?securityGuardId=<uuid>` and `req.params.tenantId` undefined, the query runs with **no tenant constraint** and returns the guard's email/phone/name plus tenant name/logo for any draft guard. Enumerable by guessing a UUID.
**Fix:** remove the `securityGuardId` fallback (mirror `userPublicFind`, token-only). If id lookup must stay, require a valid invitation token and always constrain by the token's `tenantId`.

**C3. `GET /tenant/:tenantId` returns any tenant's record with no permission/membership check**
`src/api/tenant/tenantFind.ts:4-23`; `tenantService.ts:485-492`; `tenantRepository.ts:314-330`; `tenantMiddleware.ts:11-15` sets `currentTenant` without `isUserInTenant`.
Any authenticated user reads another tenant's name, taxNumber, plan, `planStripeCustomerId`, settings, logo.
**Fix:** add membership check (`isUserInTenant`) / `validateHas(tenantRead)` in `tenantFind`; better, make `tenantMiddleware` perform the same `isUserInTenant` check `tenantHeaderMiddleware.ts:23` already does, so all `:tenantId` routes fail closed.

**C4. Cross-client leakage of post sites / guard rosters / metrics — URL id, no ownership check**
`src/api/clientAccount/clientAccountPostSites.ts:31` (+ `businessInfoRepository.ts:610-618`); `clientAccountGuards.ts:14,22-31,59`; `clientAccountOverview.ts:11,37-160`.
The customer role holds `businessInfoRead`/`securityGuardRead`, so a customer calling these with **another** `clientAccountId` in the URL receives that client's post sites, guard roster (name/email/phone), and operational metrics. The repo customer branch only checks a `clientAccountId` filter is *present*, never that it equals `currentUser.clientAccountId`. (Note `clientAccountGuards.ts:27` also references a non-existent `tuc.tenantId` column → 500 if absent.)
**Fix:** for customer callers, force `args.filter.clientAccountId = currentUser.clientAccountId` (or `Error403` on mismatch); fix the repo branch to **override**, not trust, the supplied id.

**C5. Assigned-guards SQL endpoints leak guard PII across post sites/stations**
`src/api/postSite/postSiteAssignedGuards.ts:5-67`; `src/api/station/stationAssignedGuards.ts:5-91`; `src/api/postSite/postSiteStationAssignedGuards.ts:5-58`.
Gate only on `userRead`, then raw SQL scoped by `tenantId` + a URL-supplied id with **no** `assignedPostSites`/`clientAccountId` ACL. A customer enumerates post-site/station UUIDs in the tenant and reads guard PII for other clients' sites.
**Fix:** resolve the caller's allowed post-site ids (reuse `stationRepository.findById` ACL) and 404 when the requested id is not in that set for non-admins.

**C6. `invoiceByClient` lets a customer read other clients' invoices**
`src/api/invoice/invoiceByClient.ts:13-27`; `permissions.ts:376` (`invoiceRead` includes `customer`).
Filters by `req.params.clientId` with no customer isolation (unlike `invoiceList`/`invoiceFind`/`invoiceDownload`). A customer enumerates any client's invoices, amounts, payments.
**Fix:** apply the same customer guard — resolve own `clientAccount.id`, `Error403` when `req.params.clientId` differs; centralize in `InvoiceService.findAndCountAll`.

**C7. Cross-tenant tag-scan IDOR + patrol mis-attribution (no tenant/guard scope)**
`src/services/siteTourService.ts:68,76-82`; `src/api/guard/guardMePatrolStart.ts:37-39` (route `siteTour.ts:511`).
`recordTagScan` resolves the checkpoint by `tagIdentifier` alone and the assignment by `{siteTourId, status:'assigned'}` alone — no `tenantId`, no `securityGuardId`. `tagIdentifier` is only unique per-tenant, so a guard scanning a colliding code resolves and writes against **another tenant's** tour, and even stamps the foreign assignment with the scanner's tenantId. With two guards on one tour, scans attach to the first `assigned` row (wrong-guard attribution + double-completion race).
**Fix:** scope every lookup by `tenantId` AND `securityGuard.id`; add a composite unique index on `siteTourTag(tenantId, tagIdentifier)`; lock the assignment row before the completion count.

**C8. Clock-in allows two concurrent OPEN shifts at different stations (overlap)**
`src/api/guard/guardMeClockIn.ts:222-239` with `attendanceService.findOpenOrShiftRecord:602-636`.
The "already_clocked_in" guard is scoped to the **same** station + matched shift. A guard open at station A who clocks in at station B gets a brand-new open `guardShift` (lines 263-289) — two overlapping open sessions. Clock-out (`guardMeClockOut.ts:48-51`) closes only one, leaving the other permanently open.
**Fix:** before opening, query for ANY open `guardShift` for this guard across all stations; if one exists at a different station, reject with `already_clocked_in_elsewhere` (or auto-clock-out the prior).

**C9. Adhoc assignment bypasses all double-booking prevention**
`src/services/assignmentService.ts:62-122` (overlap block inside `if (!isAdhoc)`); reached via `src/api/postSite/postSiteAssignGuard.ts:74-144`.
When `positionId` is null (station has no positions), an adhoc assignment is created with a one-year horizon and zero overlap check; `shiftGenerationService.ts:401-423` only purges shifts of non-active assignments, so rotation + adhoc shifts coexist on the same day/time.
**Fix:** move the active-assignment/overlap guard out of `if (!isAdhoc)`, or add an explicit time-range overlap check before adhoc create, reusing `_assertNoGuardOverlap`'s predicate.

**C10. All bulk/generated shift-writing paths skip the overlap check**
`src/services/shiftGenerationService.ts:439` (`bulkCreate`); `src/services/scheduleProposalService.ts:321-337` (publish "add"); `src/api/scheduling/schedulingEndpoints.ts:713-719` (auto-assign).
The only overlap guard lives in `ShiftService.create/update`. `ignoreDuplicates` against `uniq_shift_slot` collapses only exact `(guard,station,start,end)` repeats; overlapping times / different stations both insert. No DB exclusion constraint exists.
**Fix:** centralize a guard-overlap assertion called from every shift-writing path, **and/or** add a Postgres `EXCLUDE` constraint via `btree_gist` on `(guardId WITH =, tstzrange(startTime,endTime) WITH &&)` scoped per tenant.

### HIGH

**H1. Guard incident-create trusts client-supplied `stationId`/`postSiteId` (mass-assignment + cross-client notify)**
`src/api/guard/guardMeIncidentCreate.ts:37-38,75-76,170-187`.
FK fields are taken from `req.body` with no tenant/assignment validation, written onto the incident, and passed to `notifyClient` — a guard can attribute an incident (with photo) to and notify the owning client of **another** client's/tenant's site.
**Fix:** validate `data.stationId` against `{id, tenantId}` AND require the guard be assigned (mirror `guardMeOrderComplete.ts:27-31`); derive `postSiteId` from the validated station; `Error400` otherwise.

**H2. `businessInfo`/post-site autocomplete and export ignore client ACL**
`businessInfoRepository.ts:662-701` (`findAllAutocomplete`, scopes only by tenant); `businessInfoExport.ts:49-81` (+ repo `610-618`).
Customer holds `businessInfoAutocomplete`/`businessInfoRead`; autocomplete returns every post site in the tenant, and export accepts `?filter={"clientAccountId":"<OTHER>"}` to export another client's sites.
**Fix:** apply the `findAndCountAll` ACL (restrict to `currentUser.clientAccountId` / `assignedPostSites`); force/override the customer's own `clientAccountId` on export.

**H3. `publishProposal` can ship detected double-bookings**
`src/services/scheduleProposalService.ts:284-292` vs `162-180`; `scheduleValidation.ts:33-67`.
The only hard publish gate is coverage `gapCount`; `doubleBookings` are advisory. Also `detectRestWarnings` only flags same-day different-station, missing same-station overlaps and midnight-spanning shifts.
**Fix:** reject (or require explicit `allowDoubleBookings`) when `warnings.doubleBookings.length > 0`; strengthen `detectRestWarnings` to a real start/end overlap test.

**H4. Shift-exchange approval is a no-op; create accepts arbitrary shift/guard ids**
`shiftExchangeRequestUpdateStatus.ts:17` + `shiftExchangeRequestRepository.ts:39-67` (approval only flips status, never swaps `guardId`); `shiftExchangeRequestCreate.ts:9` + repo `15-29` (stores `fromShiftId`/`toGuardId` verbatim, no tenant/ownership validation).
The feature is broken AND an isolation/integrity gap.
**Fix:** implement the swap in a transaction with overlap assertion on each post-swap guard; validate every referenced id via `filterIdInTenant` and assert the requester owns `fromShift`.

**H5. `userResendInvitation` redirects invitation token to an arbitrary email (account-takeover primitive)**
`src/api/user/userResendInvitation.ts:68` (`req.body.email || req.body.to || tenantUser.user.email`).
An admin with `userEdit` can mint/resend a valid invite token to any attacker mailbox; completing it sets a password and activates membership.
**Fix:** always send to `tenantUser.user.email`; ignore client-supplied recipient. Convert not-found/already-accepted throws to `Error404`/`Error400`.

**H6. `inventoryAssignment` create writes unvalidated cross-tenant FKs and flips item status without tenant scope**
`inventoryAssignmentRepository.ts:14-34` (via service `11-24`, handler `8-10`).
`lodash.pick`s `inventoryItemId`/`stationId`/`postSiteId`/`assignedToUserId` with no `filterIdInTenant`; `inventoryItem.update({status:'asignado'})` at `30-33`/`69` has **no `tenantId`** in the `where`. A tenant-A user flips a tenant-B item's status and attaches assignments to foreign stations/users.
**Fix:** validate each FK via `filterIdInTenant`; add `tenantId` to the `inventoryItem.update` where-clauses.

**H7. Patrol auto-complete falsely triggered by duplicate inventory snapshots**
`patrolInventoryCreate.ts:79-90`; `patrolConfirmInventories.ts:71-83`.
No uniqueness on `(patrolId, inventoryOriginId)`; completion uses a non-distinct count, so two complete snapshots of one inventory satisfy `checkedCount >= invIds.length` and wrongly close the patrol.
**Fix:** count `distinct inventoryOriginId`; `findOrCreate`/unique-constraint on `(tenantId, patrolId, inventoryOriginId)`.

**H8. `patrolConfirmInventories` leaks HTML stack trace + wrong status**
`patrolConfirmInventories.ts:32,86-88`.
Uses `next(error)` with `err.code=404`; the global handler keys off `err.status`/`statusCode` not `err.code`, so a not-found returns HTTP 500 with a raw HTML stack trace to the worker app.
**Fix:** wrap with `ApiResponseHandler.error`; throw typed `Error404`/`Error400`.

**H9. Inbound Twilio SMS webhook has no idempotency**
`superadminMessagingService.ts:87-110` (`recordInbound`), called from `twilio/webhooks.ts:90-116`.
Unconditional `twilioMessage.create()` with a non-unique `twilio_msg_sid` index; Twilio retries duplicate the row, re-bump `unreadCount`, and re-fire the notification.
**Fix:** dedup on `twilioSid` before insert; add a partial-unique index on `twilioSid`.

**H10. Payment creation: lost-update race on `invoice.payments` JSON array**
`paymentService.ts:14-60`; `invoiceRepository.ts:55-99`.
Read-modify-write on a JSON column with no `FOR UPDATE` lock; concurrent posts drop a payment and can jointly exceed the invoice total. Payment id uses `Math.random()` (non-crypto, not idempotent).
**Fix:** `findById` with `lock: LOCK.UPDATE`; add an idempotency key and a UUID id. Longer term move payments to a real table.

**H11. Estimate→Invoice conversion is non-transactional and duplicable**
`estimateService.ts:281-318` (handler `estimateConvert.ts`).
Invoice-create then estimate-destroy are separate; destroy failure is swallowed, and no already-converted guard — a retry/double-click creates duplicate invoices.
**Fix:** wrap both in one transaction; mark estimate `status='converted'` / `convertedInvoiceId` and reject re-conversion; optionally unique-index `invoice.referenceEstimateId`.

**H12. KPI read/export endpoints have no permission check; writes only shadow-gated**
`kpiList.ts:4-11`, `kpiFind.ts:4-11`, `kpiAutocomplete.ts`, `kpiExcel.ts`, `kpiPdf.ts` (no gate); `kpiCreate/Update/Destroy` use `enforceGate`, which only enforces when `RBAC_ENFORCE_NEW_GATES` is on (`gateEnforcement.ts:11-13`).
Intra-tenant RBAC bypass (tenant scoping intact).
**Fix:** add `validateHas(kpiRead)` to all reads/exports and real gates to writes; confirm `RBAC_ENFORCE_NEW_GATES` is enabled in prod.

**H13. Post-site / station soft-delete orphans children, assignments, and shifts**
`businessInfoRepository.ts:180-214` (destroy); `stationRepository.ts:170-203` (destroy).
Bare soft-delete leaves child stations, active `guardAssignment`s, future `shift`s and `stationPosition`s dangling — orphaned data still surfaces in shift queries and keeps "active" assignments that corrupt future scheduling (compounds C9). `update()` blocks archiving when guards are linked; `destroy()` has no such guard.
**Fix:** in the transaction, block deletion when active children exist, or cascade: soft-delete child stations, end active assignments, purge future shifts.

**H14. `siteTour` PATCH/PUT mass-assign `req.body` into `update()`**
`siteTour.ts:158,313,326`.
`Object.assign(updateData, req.body)` / `tag.update(req.body)` lets a client set `tenantId`/`postSiteId`/`createdById`/`id`, re-parenting a ronda to another client/tenant.
**Fix:** explicit editable-column whitelist; never accept `tenantId`/`createdById`/`id` from the body.

**H15. Raw `Error` throws → 500 + raw message across guard/user/invite handlers**
`securityGuardInvite.ts:30,104,217,266`; `securityGuardPublicCreate.ts:30,63,73`; `userResendInvitation.ts:29,33,70` (root cause `apiResponseHandler.ts:24,85-86`).
Validation/not-found conditions return HTTP 500 with the raw thrown message (and any rethrown DB error), breaking frontend toasts and leaking internals.
**Fix:** replace with typed `Error400`/`Error404`; audit so no user-facing throw lacks a 4xx code. (Same class also in financial/messaging/siteTour — see policy §4.)

### MEDIUM

- **M1. `businessInfoFind` blanket `bypassPermissionValidation`** (`businessInfoFind.ts:32,55-91`; repo `232,255`) — disables repo ACL for reads; isolation hinges on a single post-fetch check, and multi-access pivot users are denied their own data. Restrict bypass to the post-create flow only.
- **M2. Customer→client resolution ignores the multi-access pivot** (`businessInfoList.ts:38-46`, `businessInfoFind.ts:70-80`, `securityGuardList.ts:74-82`, `securityGuardFind.ts:41-49`) — resolves via `clientAccount.userId`, so granted extra users get empty/403. Centralize resolution consulting `userId` + `tenant_user_client_accounts` + JWT `clientAccountId`.
- **M3. `securityGuardFind` queries non-existent `postSite` column** (`securityGuardFind.ts:77-88`) — should be `postSiteId`; currently throws → caught as `Error403`, so legitimate customers can *never* fetch their own guard's detail (fails closed but broken).
- **M4. Guard-create dedup runs outside the transaction (TOCTOU)** (`securityGuardService.ts:34-52` vs `268-271`) — concurrent invite + public-register can double-insert; no unique index on `(guardId, tenantId)`. Add the partial unique index.
- **M5. `send-password-reset` returns the reset token/link in the response body** (`securityGuardSendPasswordReset.ts:48,78-84`) — bypasses the out-of-band channel; also not-found throws `Error400` not `Error404`. Return only `{success, emailed, pushed}`.
- **M6. Guard/`registerGuardDevice` device registration non-atomic** (`guardMeDeviceToken.ts:36-49`; `guardDeviceService.ts:53-80`) — duplicate device rows split the anti-buddy-punching bind state. Use `findOrCreate` + partial-unique `(tenantId, deviceId)`.
- **M7. `routeRun`/`stationOrder` create without validating `routeId`/`stationId` in tenant** (`routeRun/index.ts:39-41,53`; `stationOrder/index.ts:42-49`) — fabricate records against foreign ids; stationOrder proceeds even when `station` is null. Load with `{id, tenantId}` and 404 first.
- **M8. `siteTour` POST/PUT don't validate `stationId`/`postSiteId` in tenant** (`siteTour.ts:78-95,131-143,203-223`) — attach a ronda to a foreign station. Use `filterIdInTenant`.
- **M9. Not-found via bare `Error('Not found')`** (`siteTour.ts:130,155,171,311,325,338`) — falls to 500 instead of 404. Throw `Error404`.
- **M10. `guardAssignmentDelete` hard-deletes ALL shifts incl. past** (`schedulingEndpoints.ts:221-242`) — loses schedule history; no orphan-shift sweep. Scope destroy to future shifts; add a periodic orphan sweep.
- **M11. `scheduleOverrideCreate` absence delete by fragile local-date string match; working overrides never reconcile shifts** (`schedulingEndpoints.ts:789-815`) — DST/tz mismatch; working overrides not overlap-checked. Use tz-aware `[dayStartUtc, dayEndUtc)` range.
- **M12. Unique-number retry loop reuses an aborted transaction** (`invoiceService.ts:120-143`; `estimateService.ts:70-93`) — retry on the same aborted txn cannot recover under concurrency. Create a fresh transaction per attempt or use DB-side atomic allocation.
- **M13. `InventoryHistoryService.destroyAll` iterates unnormalized `req.query.ids`** (`inventoryHistoryService.ts:99`) — a string id iterates per-character. Normalize to array.
- **M14. `postSiteRemoveAssignment` plain `Error`→500 + fallback DELETE not tenant-scoped** (`postSiteRemoveAssignment.ts:14-29`) — fallback filters by `businessInfoId` only and silently no-ops on the station route. Throw `Error400`; add `tenantId` to the fallback; return 404 on zero rows.
- **M15. Plain-Error → 500 in financial/messaging paths** (`paymentService.ts:16,45`, `invoiceService.ts:499,242,237`, `estimateService.ts:178,287,321,327`; `messageEndpoints.ts:40,56,79,102,121`, `groupEndpoints.ts:33,36,88`) — wrong status + raw-message leak. Throw `Error400`/`Error404`.

### LOW (track, batch-fix)
`guardMeTimeOffCreate` no dedup (`:36-47`); `siteTour` routes bypass `ApiResponseHandler` + raw-SQL debug fallback + `res.status(500)` (`:10-180,538-602,641`); `stationOrder` returns `success:false` with HTTP 200 on not-found (`:63,111`); debug logging of tenant/user/SQL ids (`siteTour.ts`, `incidentService.ts:38-46`, `customerAccountMe.ts`, `permissionChecker.ts:150-246`, `businessInfoFind.ts:24-26`); `inventoryItem` no serial-number dedup (`inventoryItemRepository.ts:15-26`); patrol-scoped inventory-history unbounded pagination (`inventoryHistoryRepository.ts:300,436`); `shiftAssign`/`schedulingEndpoints` raw `res.status().json` (`shiftAssign.ts:20-22`); `securityGuardSelfUpdate` no `PermissionChecker` + fail-open privilege-check catch (`securityGuardSelfUpdate.ts:7-49`, `tenantUserRepository.ts:573-575`); Meta/Twilio webhook signature verification fails open when no secret configured (`metaWebhook.ts:99-100`, `twilio/webhooks.ts:59-62`); `settingsFind` no permission check (`settingsFind.ts:4-13`); `clientLog` ungated log-injection (`clientLogCreate.ts:3-22`); `category` create mass-assigns `req.body` + unbounded `ids` (`categoryCreate.ts:14-16`, `categoryDestroy.ts:12`); duplicate `/stations` route registration with dead businessInfo aliases (`station/index.ts:41-79` vs `99-137`).

---

## 4. Recommended Error-Management Policy (PR checklist)

Adopt as the standard for every route handler and service. A PR touching an endpoint must satisfy:

**1. Typed errors only — never bare `Error` on a user-facing path.**
- Throw `Error400` (bad/empty/malformed input), `Error401` (auth), `Error403` (forbidden/ownership), `Error404` (not found) from `src/errors`.
- Rationale: `ApiResponseHandler.error` returns the structured `{message,code,messageCode,errors}` body **only** for codes 400/401/403/404 (`apiResponseHandler.ts:24`); anything else returns HTTP 500 echoing `error.message` — wrong status + internal-detail leak. Reserve bare `Error` for genuinely unexpected failures, and do **not** echo `error.message` on the 500 branch.

**2. Status-code correctness.** Validation → 400, missing/foreign record → 404, permission/ownership → 403. No `success:false` with HTTP 200 for not-found; no `res.status(...).json/send` shortcuts that bypass `ApiResponseHandler`.

**3. Consistent response shape.** Success via `ApiResponseHandler.success`; all errors via `ApiResponseHandler.error(req,res,error)`. No `next(err)` for business errors (the global handler keys off `err.status`/`statusCode`, not `err.code`).

**4. Global safety net.** Add a terminal 4-arg Express middleware after all routes that calls `ApiResponseHandler.error` when `!res.headersSent` (closes `src/api/index.ts:332-345`).

**5. Permission gate on every handler.** `new PermissionChecker(req).validateHas(Permissions.values.X)` — including read/export handlers (KPI, settings). If RBAC shadow-gating is used, confirm `RBAC_ENFORCE_NEW_GATES` is on in prod or the gates are no-ops.

**6. Tenant scoping is non-negotiable.** Every query filters by `SequelizeRepository.getCurrentTenant`. Middleware that sets `req.currentTenant` must verify `isUserInTenant` (fail closed). Routes must live under `/tenant/:tenantId/...`.

**7. Ownership/ACL for customer-reachable reads.** Never trust a caller-supplied `clientAccountId`/`postSiteId`/`stationId`/`clientId` from URL or body. Force it to the caller's own scope (resolved via a single shared helper consulting `clientAccount.userId` + `tenant_user_client_accounts` + JWT `clientAccountId`), or `Error403` on mismatch. Override, don't merely "require a filter is present."

**8. Validate and constrain every foreign key.** Resolve FKs via `Repository.filterIdInTenant` before persisting (mirror `incidentService.create`). Reject when not in tenant.

**9. No mass-assignment.** `lodash.pick` an explicit allowlist at the repo/service boundary; never `Object.assign(record, req.body)` / pass `req.body` straight to `create/update`. Forbid `tenantId`/`createdById`/`id` from the body.

**10. Idempotency & uniqueness on every create/write that the app can retry.** Worker-app posts, webhooks, and financial writes need a dedup key (`clientMsgId`, `twilioSid`, idempotency key) backed by a partial-unique DB index. Read-modify-write on JSON arrays/counters must hold a row lock (`LOCK.UPDATE`) inside the transaction.

**11. Bounded inputs.** Clamp `limit` (default 25, max 100); normalize `ids` to an array before iterating.

**12. No internal leakage in logs or responses.** No raw stack traces / Sequelize errors to the client; gate tenant/user/SQL debug logs behind a flag and remove dev-only raw-SQL fallbacks.

---

## 5. Suggested Remediation Order

**Phase 0 — Stop active leaks (this week, blocking).**
1. Lock down or remove `tenant_user_client_accounts` CRUD (C1).
2. Remove the `securityGuardId` fallback on `/security-guard/public` (C2).
3. Add `isUserInTenant` to `tenantMiddleware` and gate `tenantFind` (C3) — this single middleware fix hardens every `:tenantId` route.
4. Add ownership checks to the cross-client endpoints: `clientAccount*`, assigned-guards SQL, `invoiceByClient`, autocomplete/export (C4, C5, C6, H2).
5. Scope `recordTagScan` / patrol-start by tenant + guard, add the `(tenantId, tagIdentifier)` unique index (C7).
6. Fix `userResendInvitation` recipient (H5) and stop returning the reset token (M5).

**Phase 1 — Enforce Invariant 4 (no double-booking).**
7. Add a Postgres `EXCLUDE` constraint (`btree_gist`) on guard × `tstzrange(start,end)` per tenant — the durable backstop covering all paths (C10).
8. Centralize `_assertNoGuardOverlap` and call it from adhoc create, bulk generation, proposal publish, auto-assign, and the clock-in/clock-out attendance layer (C8, C9, C10, H3).
9. Implement the shift-exchange swap with overlap checks (H4).

**Phase 2 — Error-handling sweep (systemic, mechanical).**
10. Add the terminal Express error middleware (policy §4).
11. Replace bare `Error` throws with typed errors across guard/user/invite, financial, messaging, siteTour, patrol (H8, H15, M9, M14, M15).
12. Route `next(err)` / raw `res.status().json` handlers through `ApiResponseHandler` (siteTour, scheduling, shiftAssign).

**Phase 3 — Integrity & duplication.**
13. Idempotency/uniqueness: device registration, Twilio inbound, time-off, inventory snapshots, guard-create (M4, M6, H7, H9), with partial-unique indexes.
14. Transactional + locked: payment posting, estimate→invoice conversion, unique-number retry (H10, H11, M12).
15. Cascade/guard the post-site and station deletes (H13).

**Phase 4 — Cleanup & hardening.**
16. Centralize customer→client resolution (M2), fix `businessInfoFind` bypass (M1) and the `postSite`→`postSiteId` column bug (M3).
17. RBAC gates on KPI/settings (H12, M-class).
18. Bound pagination/normalize ids, remove debug logging, dedupe `/stations` routes, harden webhook fail-open, gate `clientLog` (Low batch).

Phases 0 and 1 are the gating risk to the four invariants; Phases 2–4 raise the codebase to its own stated baseline and are largely mechanical once the patterns above are templated.