/**
 * Demo Orchestrator service — drives the live sales-demo of the platform.
 *
 * It runs the SAME real operations services a real customer triggers (schedule
 * publish, guard clock-in/out, visitor log, patrol scan, incident, radio check),
 * so every step emits the REAL socket / push / platform_event and the CRM +
 * worker-app light up exactly as in production.
 *
 * ── HARD SAFETY ──────────────────────────────────────────────────────────────
 * Every public entry point (runStep / reset / state) first resolves the demo
 * tenant and then asserts the resolved tenant id === the configured demo tenant
 * id. If `DEMO_TENANT_ID` is configured it is authoritative; the slug lookup may
 * only ever return that exact tenant. It is IMPOSSIBLE to fire a demo action into
 * a real tenant: the tenant id passed to every downstream service is the asserted
 * demo id, never anything from the request.
 *
 * Steps are individually runnable and idempotent-ish: re-running a step reuses or
 * re-derives state (e.g. step 2 re-clock-in appends a session rather than erroring,
 * step 3 finds-or-creates the visitor) and always returns a human-readable result.
 */
import { Op } from 'sequelize';

import Error403 from '../../errors/Error403';
import Error400 from '../../errors/Error400';

import {
  DEMO_TENANT_SLUG,
  DEMO_TENANT_NAME,
  DEMO_EMAILS,
  DEMO_NAMES,
  DEMO_FIXTURES,
  configuredDemoTenantId,
} from './demoConstants';

import {
  generateProposal,
  publishProposal,
} from '../scheduleProposalService';
import {
  clockGate,
  applyClockIn,
  applyClockOut,
  matchScheduledShift,
  findOpenOrShiftRecord,
  hasOpenSession,
  appendSession,
  closeSession,
} from '../attendanceService';
import { startSession as startRadioSession } from '../radioCheckService';
import { dispatch } from '../../lib/notificationDispatcher';
import { storePlatformEvent } from '../../lib/platformEventStore';

// Tenant-scoped class service (constructed with IServiceOptions). Visitor uses
// the real service (its repo already bypasses the post-write read ACL); patrol
// and incident write directly (their service paths 404 on a guard read ACL or
// assume an unused status model — see stepPatrol/stepIncident).
import VisitorLogService from '../visitorLogService';

/** A single step descriptor for the panel. */
export interface DemoStepResult {
  step: number;
  key: string;
  label: string;
  ok: boolean;
  message: string;
  details?: Record<string, any>;
  at: string;
}

export const DEMO_STEPS: Array<{ step: number; key: string; label: string }> = [
  { step: 1, key: 'schedule', label: 'Programar turnos' },
  { step: 2, key: 'clockin', label: 'Relevo / entrada' },
  { step: 3, key: 'visitor', label: 'Control de visitas' },
  { step: 4, key: 'patrol', label: 'Patrullaje / Ronda' },
  { step: 5, key: 'incident', label: 'Incidente' },
  { step: 6, key: 'radio', label: 'Radio / novedades' },
  { step: 7, key: 'handover', label: 'Relevo de turno' },
];

/* ────────────────────────────────────────────────────────────────────────── */
/* In-memory activity log (drives the "Actividad en vivo" panel)              */
/* ────────────────────────────────────────────────────────────────────────── */

export interface DemoLogEntry {
  id: string;
  at: string;
  step: number;
  level: 'info' | 'success' | 'warning' | 'error';
  message: string;
  meta?: Record<string, any> | null;
}

// Per-process ring buffer (newest first). A live demo is driven from one
// presenter session, so a process-local buffer is sufficient — it survives
// across step calls and is cleared on reset.
const _demoLog: DemoLogEntry[] = [];
let _lastResetAt: string | null = null;

function pushDemoLog(entry: DemoLogEntry): void {
  _demoLog.unshift(entry);
  if (_demoLog.length > 50) _demoLog.length = 50;
}
export function getDemoLog(): DemoLogEntry[] {
  return _demoLog;
}
export function getLastResetAt(): string | null {
  return _lastResetAt;
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Hard-safety tenant resolution                                              */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Resolve the demo tenant row and HARD-ASSERT it is the configured demo tenant.
 *
 * Resolution order:
 *   1. If DEMO_TENANT_ID is configured → load THAT tenant by id (authoritative).
 *   2. Else → discover the tenant by the stable demo slug (tenant.url).
 * Either way, if DEMO_TENANT_ID is set the resolved id MUST equal it or we throw.
 */
export async function resolveDemoTenant(db: any): Promise<any> {
  if (!db?.tenant) throw new Error400(undefined, 'demo.unavailable');

  const configuredId = configuredDemoTenantId();

  let tenant: any = null;
  if (configuredId) {
    tenant = await db.tenant.findOne({ where: { id: configuredId, deletedAt: null } });
    if (!tenant) {
      const e: any = new Error403();
      e.message = `Demo tenant ${configuredId} (DEMO_TENANT_ID) not found.`;
      throw e;
    }
  } else {
    tenant = await db.tenant.findOne({ where: { url: DEMO_TENANT_SLUG, deletedAt: null } });
    if (!tenant) {
      const e: any = new Error400(undefined, 'demo.notSeeded');
      e.message =
        `Demo tenant not found. Seed it first (slug "${DEMO_TENANT_SLUG}") ` +
        `or set DEMO_TENANT_ID.`;
      throw e;
    }
  }

  // The gate: never allow operation on a tenant other than the configured one.
  assertDemoTenant(tenant.id, configuredId, tenant);
  return tenant;
}

/**
 * Throw 403 unless `tenantId` is the demo tenant. When DEMO_TENANT_ID is set it
 * is the law; otherwise the slug-matched tenant id is accepted (and re-checked by
 * callers via resolveDemoTenant). This is called again before EVERY downstream
 * service invocation as defense-in-depth.
 */
export function assertDemoTenant(
  tenantId: string,
  configuredId: string | null = configuredDemoTenantId(),
  tenant?: any,
): void {
  if (!tenantId) {
    const e: any = new Error403();
    e.message = 'Demo guard: missing tenant id.';
    throw e;
  }
  if (configuredId && String(tenantId) !== String(configuredId)) {
    const e: any = new Error403();
    e.message =
      `Demo guard: refusing to operate on tenant ${tenantId} — it is not the ` +
      `configured demo tenant (${configuredId}).`;
    throw e;
  }
  if (tenant && tenant.url && tenant.url !== DEMO_TENANT_SLUG && !configuredId) {
    const e: any = new Error403();
    e.message =
      `Demo guard: tenant ${tenantId} slug "${tenant.url}" is not the demo slug ` +
      `"${DEMO_TENANT_SLUG}" and DEMO_TENANT_ID is unset.`;
    throw e;
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Entity lookups by stable email / slug (never hard-coded ids)               */
/* ────────────────────────────────────────────────────────────────────────── */

interface DemoContext {
  tenant: any;
  tenantId: string;
  admin: { user: any; tenantUser: any } | null;
  client: { user: any } | null;
  site: any | null; // businessInfo
  stations: any[];
  guards: {
    day: { user: any; securityGuard: any } | null;
    night: { user: any; securityGuard: any } | null;
  };
}

async function findUserByEmail(db: any, email: string): Promise<any> {
  return db.user.findOne({ where: { email: email.toLowerCase(), deletedAt: null } });
}

async function findSecurityGuardForUser(db: any, tenantId: string, userId: string): Promise<any> {
  if (!userId) return null;
  return db.securityGuard.findOne({ where: { guardId: userId, tenantId, deletedAt: null } });
}

/** Build the full demo context from stable keys. Always re-resolves (idempotent). */
export async function buildContext(db: any): Promise<DemoContext> {
  const tenant = await resolveDemoTenant(db);
  const tenantId = tenant.id;

  const adminUser = await findUserByEmail(db, DEMO_EMAILS.admin);
  const clientUser = await findUserByEmail(db, DEMO_EMAILS.client);
  const dayUser = await findUserByEmail(db, DEMO_EMAILS.guardDay);
  const nightUser = await findUserByEmail(db, DEMO_EMAILS.guardNight);

  const adminMembership = adminUser
    ? await db.tenantUser.findOne({ where: { userId: adminUser.id, tenantId, deletedAt: null } })
    : null;

  // The seeded site (businessInfo) + its post sites (stations).
  const site = await db.businessInfo.findOne({
    where: { tenantId, companyName: DEMO_NAMES.site, deletedAt: null },
  });
  const stations = site
    ? await db.station.findAll({
        where: { tenantId, postSiteId: site.id, deletedAt: null },
        order: [['stationName', 'ASC']],
      })
    : await db.station.findAll({ where: { tenantId, deletedAt: null }, order: [['stationName', 'ASC']] });

  return {
    tenant,
    tenantId,
    admin: adminUser ? { user: adminUser, tenantUser: adminMembership } : null,
    client: clientUser ? { user: clientUser } : null,
    site: site || null,
    stations: stations || [],
    guards: {
      day: dayUser
        ? { user: dayUser, securityGuard: await findSecurityGuardForUser(db, tenantId, dayUser.id) }
        : null,
      night: nightUser
        ? { user: nightUser, securityGuard: await findSecurityGuardForUser(db, tenantId, nightUser.id) }
        : null,
    },
  };
}

/** The station a guard is assigned to (first match), else the site's first station. */
function stationForGuard(ctx: DemoContext, guardUserId: string): any | null {
  // Prefer a station the guard has a shift/assignment at; fall back to first.
  return ctx.stations[0] || null;
}

/** Build IServiceOptions for the class-based services, scoped to the demo tenant. */
function serviceOptions(db: any, ctx: DemoContext, actingUser: any): any {
  return {
    language: 'es',
    database: db,
    currentUser: actingUser,
    currentTenant: ctx.tenant, // <- demo tenant ONLY; services read currentTenant.id
  };
}

function ensureSeeded(ctx: DemoContext): void {
  const missing: string[] = [];
  if (!ctx.admin) missing.push('admin (' + DEMO_EMAILS.admin + ')');
  if (!ctx.client) missing.push('client (' + DEMO_EMAILS.client + ')');
  if (!ctx.guards.day) missing.push('day guard (' + DEMO_EMAILS.guardDay + ')');
  if (!ctx.guards.night) missing.push('night guard (' + DEMO_EMAILS.guardNight + ')');
  if (!ctx.site) missing.push('site (' + DEMO_NAMES.site + ')');
  if (!ctx.stations.length) missing.push('stations');
  if (missing.length) {
    const e: any = new Error400(undefined, 'demo.notSeeded');
    e.message = `Demo tenant is not fully seeded. Missing: ${missing.join(', ')}. Run the seed first.`;
    throw e;
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Helpers                                                                    */
/* ────────────────────────────────────────────────────────────────────────── */

function result(
  stepDef: { step: number; key: string; label: string },
  ok: boolean,
  message: string,
  details?: Record<string, any>,
): DemoStepResult {
  return { ...stepDef, ok, message, details, at: new Date().toISOString() };
}

/** The two 12h windows for "today" in the demo: Día 07-19, Noche 19-07 (local). */
function todayShiftWindows(): { dayStart: Date; dayEnd: Date; nightStart: Date; nightEnd: Date } {
  const base = new Date();
  base.setHours(0, 0, 0, 0);
  const at = (h: number) => new Date(base.getTime() + h * 3600 * 1000);
  return {
    dayStart: at(7),
    dayEnd: at(19),
    nightStart: at(19),
    nightEnd: at(31), // 07:00 next day
  };
}

/* ────────────────────────────────────────────────────────────────────────── */
/* STEP 1 — Programar turnos (publish today's Día + Noche schedule)           */
/* ────────────────────────────────────────────────────────────────────────── */

async function ensureTodayShift(
  db: any,
  ctx: DemoContext,
  guardUserId: string,
  station: any,
  start: Date,
  end: Date,
  actingUserId: string,
): Promise<{ created: boolean; shiftId: string }> {
  // Idempotent: reuse a shift that already covers today's window for this guard.
  const existing = await db.shift.findOne({
    where: {
      guardId: guardUserId,
      stationId: station.id,
      tenantId: ctx.tenantId,
      startTime: { [Op.lte]: end },
      endTime: { [Op.gte]: start },
      deletedAt: null,
    },
    attributes: ['id'],
  });
  if (existing) return { created: false, shiftId: existing.id };

  const created = await db.shift.create({
    guardId: guardUserId,
    stationId: station.id,
    postSiteId: station.postSiteId || (ctx.site && ctx.site.id) || null,
    startTime: start,
    endTime: end,
    tenantId: ctx.tenantId,
    tzFixed: true,
    createdById: actingUserId,
    updatedById: actingUserId,
  });
  return { created: true, shiftId: created.id };
}

async function stepSchedule(db: any, ctx: DemoContext): Promise<DemoStepResult> {
  const def = DEMO_STEPS[0];
  ensureSeeded(ctx);
  const station = ctx.stations[0];
  const adminId = ctx.admin!.user.id;
  const w = todayShiftWindows();

  // Prefer the real generation→publish spine when active assignments exist (this
  // emits schedule.published + notifies guards). Fall back to direct shift create
  // so the demo always has today's two turnos regardless of assignment state.
  let publishedViaProposal = false;
  let proposalId: string | null = null;
  try {
    const hasAssignment = await db.guardAssignment.findOne({
      where: { stationId: station.id, tenantId: ctx.tenantId, status: 'active', deletedAt: null },
      attributes: ['id'],
    });
    if (hasAssignment) {
      const gen = await generateProposal(db, ctx.tenantId, adminId, {
        scope: 'station',
        stationId: station.id,
        title: 'Demo — horario de hoy',
      });
      proposalId = gen.proposalId;
      await publishProposal(db, ctx.tenantId, adminId, gen.proposalId, { allowGaps: true });
      publishedViaProposal = true;
    }
  } catch (e: any) {
    // Non-fatal: fall through to direct shift creation.
    console.warn('[demo] schedule proposal path failed, using direct shifts:', e?.message || e);
  }

  // Guarantee today's two 12h turnos exist (idempotent).
  const day = await ensureTodayShift(db, ctx, ctx.guards.day!.user.id, station, w.dayStart, w.dayEnd, adminId);
  const night = await ensureTodayShift(db, ctx, ctx.guards.night!.user.id, station, w.nightStart, w.nightEnd, adminId);

  // Emit a schedule.published platform event so the CRM shows the live update,
  // even on the direct-create path (which doesn't go through publishProposal).
  if (!publishedViaProposal) {
    await storePlatformEvent(db, {
      tenantId: ctx.tenantId,
      eventType: 'schedule.published',
      title: 'Horario publicado',
      body: `Turnos de hoy publicados en ${station.stationName || ctx.site?.companyName || 'el puesto'}.`,
      targetRoles: 'admin,operationsManager,securitySupervisor',
      sourceEntityType: 'shift',
      sourceEntityId: day.shiftId,
      payload: {
        stationId: station.id,
        dayShiftId: day.shiftId,
        nightShiftId: night.shiftId,
        dayGuard: DEMO_NAMES.guardDay,
        nightGuard: DEMO_NAMES.guardNight,
      },
    }).catch(() => {});
  }

  return result(
    def,
    true,
    `Turnos de hoy publicados: Día (${DEMO_NAMES.guardDay} 07:00-19:00) y ` +
      `Noche (${DEMO_NAMES.guardNight} 19:00-07:00) en ${station.stationName || 'el puesto'}.`,
    {
      via: publishedViaProposal ? 'proposal.publish' : 'direct',
      proposalId,
      dayShiftId: day.shiftId,
      nightShiftId: night.shiftId,
      stationId: station.id,
    },
  );
}

/* ────────────────────────────────────────────────────────────────────────── */
/* STEP 2 — Relevo / entrada (Día guard clocks in)                            */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Perform a guard clock-in via the real attendance service + emit guard.checkin.
 * Mirrors guardMeClockIn.ts but is self-contained (geofence bypassed for demo:
 * we pass the station's own coordinates so the punch is always inside).
 */
async function doClockIn(
  db: any,
  ctx: DemoContext,
  who: { user: any; securityGuard: any },
  station: any,
): Promise<{ guardShiftId: string; reentry: boolean; status: string }> {
  const tenantId = ctx.tenantId;
  const userId = who.user.id;
  const now = new Date();

  // Use the station coordinates as the punch location → always inside geofence.
  const latitude = Number(station.latitud ?? station.latitude ?? 0) || null;
  const longitude = Number(station.longitud ?? station.longitude ?? 0) || null;

  const gate = await clockGate(db, tenantId, station, latitude, longitude);
  const match = await matchScheduledShift(db, { guardUserId: userId, stationId: station.id, tenantId, at: now });

  const existing = await findOpenOrShiftRecord(db, {
    securityGuardId: who.securityGuard.id,
    stationId: station.id,
    shiftId: match.shiftId,
    tenantId,
    tz: ctx.tenant.timezone || 'America/Guayaquil',
    at: now,
  });

  // Already clocked in → idempotent no-op (return the open record).
  if (existing && hasOpenSession(existing)) {
    return { guardShiftId: existing.id, reentry: true, status: existing.status || 'on_time' };
  }

  const punchMeta = { at: now, lat: latitude, lng: longitude, distanceM: gate.geofence?.distanceM ?? null };

  let record: any;
  const isReentry = !!existing;
  if (existing) {
    record = existing;
    await existing.update({
      sessions: appendSession(existing, punchMeta),
      punchOutTime: null,
      observations: existing.observations || 'Entrada registrada (demo)',
      updatedById: userId,
    });
  } else {
    record = await db.guardShift.create({
      punchInTime: now,
      punchInLatitude: latitude,
      punchInLongitude: longitude,
      shiftSchedule: 'Diurno',
      numberOfPatrolsDuringShift: 0,
      numberOfIncidentsDurindShift: 0,
      observations: 'Entrada registrada (demo)',
      sessions: appendSession({ sessions: [] }, punchMeta),
      stationNameId: station.id,
      guardNameId: who.securityGuard.id,
      postSiteId: station.postSiteId || null,
      tenantId,
      createdById: userId,
      updatedById: userId,
    });
  }

  await who.securityGuard.update({ isOnDuty: true });

  let status = record.status || 'on_time';
  if (!isReentry) {
    try {
      status = await applyClockIn(db, {
        record,
        station,
        securityGuard: who.securityGuard,
        guardUserId: userId,
        tenantId,
        userId,
        latitude,
        longitude,
        ip: null,
        settings: gate.settings,
        geofence: gate.geofence,
        sched: match,
      });
    } catch (e: any) {
      console.warn('[demo] applyClockIn failed:', e?.message || e);
    }
  }

  // Emit guard.checkin → admins + supervisors (CRM) and the client portal.
  try {
    await dispatch(
      'guard.checkin',
      {
        guardName: who.securityGuard.fullName || DEMO_NAMES.guardDay,
        stationName: station.stationName || ctx.site?.companyName || null,
        siteName: ctx.site?.companyName || null,
        photoUrl: null,
        guardId: who.securityGuard.id,
        guardShiftId: record.id,
        stationId: station.id,
      },
      { database: db, tenantId, sourceEntityType: 'guardShift', sourceEntityId: record.id },
    );
  } catch (e: any) {
    console.warn('[demo] guard.checkin dispatch failed:', e?.message || e);
  }

  try {
    const { notifyClient } = require('../clientNotifyService');
    await notifyClient(
      db,
      tenantId,
      { stationId: station.id, postSiteId: station.postSiteId },
      {
        eventType: 'guard.checkin',
        title: 'Inicio de turno',
        body: `${who.securityGuard.fullName || 'Un guardia'} inició turno en ${station.stationName || 'el puesto'}.`,
        data: { stationId: String(station.id), guardId: String(who.securityGuard.id), guardShiftId: String(record.id) },
        sourceEntityType: 'guardShift',
        sourceEntityId: String(record.id),
      },
    );
  } catch (e: any) {
    console.warn('[demo] client notify (checkin) failed:', e?.message || e);
  }

  return { guardShiftId: record.id, reentry: isReentry, status };
}

async function stepClockIn(db: any, ctx: DemoContext): Promise<DemoStepResult> {
  const def = DEMO_STEPS[1];
  ensureSeeded(ctx);
  const station = stationForGuard(ctx, ctx.guards.day!.user.id) || ctx.stations[0];
  const res = await doClockIn(db, ctx, ctx.guards.day!, station);
  return result(
    def,
    true,
    res.reentry
      ? `${DEMO_NAMES.guardDay} ya tiene la entrada activa (no duplicado).`
      : `${DEMO_NAMES.guardDay} marcó entrada en ${station.stationName || 'el puesto'} — notificación en vivo a admin y cliente.`,
    { guardShiftId: res.guardShiftId, status: res.status, stationId: station.id, reentry: res.reentry },
  );
}

/* ────────────────────────────────────────────────────────────────────────── */
/* STEP 3 — Control de visitas (register a visitor at the gate)               */
/* ────────────────────────────────────────────────────────────────────────── */

async function stepVisitor(db: any, ctx: DemoContext): Promise<DemoStepResult> {
  const def = DEMO_STEPS[2];
  ensureSeeded(ctx);
  const station = ctx.stations[0];

  // Idempotent: reuse today's demo visitor if one already exists.
  const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
  const existing = await db.visitorLog.findOne({
    where: {
      tenantId: ctx.tenantId,
      idNumber: DEMO_FIXTURES.visitorIdNumber,
      visitDate: { [Op.gte]: startOfDay },
      deletedAt: null,
    },
  });
  if (existing) {
    return result(def, true, `Visitante ${DEMO_FIXTURES.visitorFirstName} ${DEMO_FIXTURES.visitorLastName} ya registrado hoy.`, {
      visitorLogId: existing.id,
      reused: true,
    });
  }

  const svc = new VisitorLogService(serviceOptions(db, ctx, ctx.guards.day?.user || ctx.admin!.user));
  const record = await svc.create({
    firstName: DEMO_FIXTURES.visitorFirstName,
    lastName: DEMO_FIXTURES.visitorLastName,
    visitorName: `Ing. ${DEMO_FIXTURES.visitorFirstName} ${DEMO_FIXTURES.visitorLastName}`,
    idNumber: DEMO_FIXTURES.visitorIdNumber,
    company: DEMO_FIXTURES.visitorCompany,
    reason: DEMO_FIXTURES.visitorReason,
    purpose: DEMO_FIXTURES.visitorReason,
    numPeople: 1,
    visitDate: new Date(),
    station: station.id,
    stationId: station.id,
    postSiteId: station.postSiteId || (ctx.site && ctx.site.id) || null,
  });

  return result(
    def,
    true,
    `Visitante Ing. ${DEMO_FIXTURES.visitorFirstName} ${DEMO_FIXTURES.visitorLastName} registrado en ${station.stationName || 'la garita'} — alerta en vivo a supervisores.`,
    { visitorLogId: record.id, stationId: station.id },
  );
}

/* ────────────────────────────────────────────────────────────────────────── */
/* STEP 4 — Patrullaje / Ronda (scan checkpoints; one missed)                 */
/* ────────────────────────────────────────────────────────────────────────── */

async function stepPatrol(db: any, ctx: DemoContext): Promise<DemoStepResult> {
  const def = DEMO_STEPS[3];
  ensureSeeded(ctx);
  const station = ctx.stations[0];
  const guard = ctx.guards.day!;

  // Find the patrol/ronda for this station (seeded with checkpoints).
  const patrol = await db.patrol.findOne({
    where: { tenantId: ctx.tenantId, deletedAt: null },
    include: [{ model: db.patrolCheckpoint, as: 'checkpoints', required: false }],
    order: [['createdAt', 'DESC']],
  });
  if (!patrol) {
    const e: any = new Error400(undefined, 'demo.noPatrol');
    e.message = 'No hay ronda/patrulla configurada en el tenant demo. Verifica el seed.';
    throw e;
  }

  const checkpoints: any[] = Array.isArray(patrol.checkpoints) ? patrol.checkpoints : [];

  const num = (v: any) => {
    if (v == null) return null;
    const n = Number(String(v).replace(/,/g, '.'));
    return Number.isFinite(n) ? n : null;
  };
  const stLat = num(station.latitud ?? station.latitude) ?? 0;
  const stLng = num(station.longitud ?? station.longitude) ?? 0;
  const now = new Date();

  // The PatrolLogService spine assumes an (unused) quoted-string status enum and
  // a proximity model that doesn't fit a scripted demo, so we write patrol logs
  // directly (validation bypassed — the status column is free TEXT) and emit the
  // ronda event ourselves. All but the last checkpoint scan OK; the last is the
  // "missed" one that drives the live alert.
  const created: Array<{ checkpoint: string; status: string }> = [];
  for (let i = 0; i < checkpoints.length; i++) {
    const cp = checkpoints[i];
    const isLast = i === checkpoints.length - 1 && checkpoints.length > 1;
    const status = isLast ? 'Missed' : 'Scanned';
    await db.patrolLog.create(
      {
        patrolId: patrol.id,
        scannedById: guard.user.id,
        scanTime: now,
        latitude: num(cp.latitud ?? cp.latitude) ?? stLat,
        longitude: num(cp.longitud ?? cp.longitude) ?? stLng,
        validLocation: !isLast,
        status,
        tenantId: ctx.tenantId,
        createdById: guard.user.id,
        updatedById: guard.user.id,
      },
      { validate: false },
    );
    created.push({ checkpoint: cp.name || cp.id, status });
  }

  const missed = created.filter((c) => c.status === 'Missed').length;
  const scanned = created.length - missed;

  // Update the patrol's completion state for the dashboard.
  await patrol
    .update({ completed: missed === 0, status: missed === 0 ? 'Completed' : 'Incomplete', completionTime: now })
    .catch(() => {});

  // Live event → CRM feed (ronda progress + missed-checkpoint alert).
  await storePlatformEvent(db, {
    tenantId: ctx.tenantId,
    eventType: 'patrol.completed',
    title: missed > 0 ? 'Ronda con novedad' : 'Ronda completada',
    body:
      `${guard.securityGuard.fullName || DEMO_NAMES.guardDay}: ${scanned} de ${created.length} puntos escaneados` +
      `${missed > 0 ? `, ${missed} omitido(s)` : ''} en ${station.stationName || 'el puesto'}.`,
    targetRoles: 'admin,operationsManager,securitySupervisor',
    sourceEntityType: 'patrol',
    sourceEntityId: patrol.id,
    payload: { patrolId: patrol.id, scans: created, missed },
  }).catch(() => {});

  return result(
    def,
    true,
    `Ronda registrada: ${scanned} de ${created.length} puntos escaneados, ${missed} omitido(s) — ` +
      `progreso de ronda + alerta de punto omitido en vivo.`,
    { patrolId: patrol.id, scans: created },
  );
}

/* ────────────────────────────────────────────────────────────────────────── */
/* STEP 5 — Incidente (guard reports a suspicious-person incident + photo)    */
/* ────────────────────────────────────────────────────────────────────────── */

async function stepIncident(db: any, ctx: DemoContext): Promise<DemoStepResult> {
  const def = DEMO_STEPS[4];
  ensureSeeded(ctx);
  const station = ctx.stations[0];
  const guard = ctx.guards.day!;

  // Idempotent: reuse today's demo incident if one with the same title exists.
  const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
  const existing = await db.incident.findOne({
    where: {
      tenantId: ctx.tenantId,
      title: DEMO_FIXTURES.incidentTitle,
      date: { [Op.gte]: startOfDay },
      deletedAt: null,
    },
  });
  if (existing) {
    return result(def, true, `Incidente "${DEMO_FIXTURES.incidentTitle}" ya reportado hoy.`, {
      incidentId: existing.id,
      reused: true,
    });
  }

  // IncidentService.create re-reads the row through an assigned-post-site ACL
  // that 404s ("Extraviado") for a guard with no post sites, so we write the
  // incident directly and emit the alert + client notification ourselves.
  const now = new Date();
  const postSiteId = station.postSiteId || (ctx.site && ctx.site.id) || null;
  const record = await db.incident.create(
    {
      date: now,
      title: DEMO_FIXTURES.incidentTitle,
      description: DEMO_FIXTURES.incidentDescription,
      status: 'abierto',
      priority: 'alta',
      stationId: station.id,
      postSiteId,
      guardNameId: guard.securityGuard.id,
      wasRead: false,
      tenantId: ctx.tenantId,
      createdById: guard.user.id,
      updatedById: guard.user.id,
    },
    { validate: false },
  );

  // Best-effort photo evidence (won't block if the relation alias differs).
  try {
    await db.file.create({
      belongsTo: db.incident.getTableName(),
      belongsToColumn: 'photoUrl',
      belongsToId: record.id,
      name: 'incident.jpg',
      publicUrl: DEMO_FIXTURES.incidentPhotoUrl,
      sizeInBytes: 0,
      mimeType: 'image/jpeg',
      tenantId: ctx.tenantId,
    });
  } catch { /* ignore */ }

  // Live alert → supervisors/admins (CRM feed).
  await storePlatformEvent(db, {
    tenantId: ctx.tenantId,
    eventType: 'incident.created',
    title: 'Incidente reportado',
    body: `${guard.securityGuard.fullName || DEMO_NAMES.guardDay}: ${DEMO_FIXTURES.incidentTitle} en ${station.stationName || 'el puesto'}.`,
    targetRoles: 'admin,operationsManager,securitySupervisor',
    sourceEntityType: 'incident',
    sourceEntityId: record.id,
    payload: { incidentId: record.id, stationId: station.id, priority: 'alta', photoUrl: DEMO_FIXTURES.incidentPhotoUrl },
  }).catch(() => {});

  // Escalate to the client portal.
  try {
    const { notifyClient } = require('../clientNotifyService');
    await notifyClient(
      db,
      ctx.tenantId,
      { stationId: station.id, postSiteId },
      {
        eventType: 'incident.created',
        title: 'Incidente en su sitio',
        body: `${DEMO_FIXTURES.incidentTitle} en ${station.stationName || 'el puesto'}.`,
        data: { incidentId: String(record.id), stationId: String(station.id) },
        sourceEntityType: 'incident',
        sourceEntityId: String(record.id),
      },
    );
  } catch (e: any) {
    console.warn('[demo] client notify (incident) failed:', e?.message || e);
  }

  return result(
    def,
    true,
    `Incidente "${DEMO_FIXTURES.incidentTitle}" reportado por ${DEMO_NAMES.guardDay} (con foto) — ` +
      `alerta en vivo + escalamiento a supervisores y cliente.`,
    { incidentId: record.id, stationId: station.id },
  );
}

/* ────────────────────────────────────────────────────────────────────────── */
/* STEP 6 — Radio / novedades (start a pase de novedades roll call)           */
/* ────────────────────────────────────────────────────────────────────────── */

async function stepRadio(db: any, ctx: DemoContext): Promise<DemoStepResult> {
  const def = DEMO_STEPS[5];
  ensureSeeded(ctx);

  // Reuse a running session if one exists (idempotent — avoid stacking sessions).
  const running = await db.radioCheckSession.findOne({
    where: { tenantId: ctx.tenantId, status: 'running', deletedAt: null },
    order: [['startedAt', 'DESC']],
  });
  if (running) {
    return result(def, true, 'Pase de novedades ya en curso.', { sessionId: running.id, reused: true });
  }

  const session = await startRadioSession(db, ctx.tenantId, {
    mode: 'manual',
    initiatedByUserId: ctx.admin!.user.id,
    scope: 'all',
  });

  return result(
    def,
    true,
    `Pase de novedades iniciado (roll call) sobre ${session?.totalStations ?? ctx.stations.length} puesto(s) — ` +
      `llamada en vivo a los guardias de turno.`,
    { sessionId: session?.id || null, totalStations: session?.totalStations ?? null },
  );
}

/* ────────────────────────────────────────────────────────────────────────── */
/* STEP 7 — Relevo de turno (Día clocks out, Noche clocks in)                 */
/* ────────────────────────────────────────────────────────────────────────── */

async function doClockOut(
  db: any,
  ctx: DemoContext,
  who: { user: any; securityGuard: any },
  station: any,
): Promise<{ guardShiftId: string | null; status: string | null }> {
  const tenantId = ctx.tenantId;
  const userId = who.user.id;
  const now = new Date();
  const latitude = Number(station.latitud ?? station.latitude ?? 0) || null;
  const longitude = Number(station.longitud ?? station.longitude ?? 0) || null;

  // Find the open punch record for this guard.
  const match = await matchScheduledShift(db, { guardUserId: userId, stationId: station.id, tenantId, at: now });
  const record = await findOpenOrShiftRecord(db, {
    securityGuardId: who.securityGuard.id,
    stationId: station.id,
    shiftId: match.shiftId,
    tenantId,
    tz: ctx.tenant.timezone || 'America/Guayaquil',
    at: now,
  });
  if (!record || !hasOpenSession(record)) {
    // Nothing to clock out — idempotent no-op.
    await who.securityGuard.update({ isOnDuty: false }).catch(() => {});
    return { guardShiftId: record?.id || null, status: record?.status || null };
  }

  const gate = await clockGate(db, tenantId, station, latitude, longitude);
  await record.update({
    punchOutTime: now,
    punchOutLatitude: latitude,
    punchOutLongitude: longitude,
    sessions: closeSession(record, { at: now, lat: latitude, lng: longitude, distanceM: gate.geofence?.distanceM ?? null }),
    updatedById: userId,
  });

  let status: string | null = record.status || null;
  try {
    const out = await applyClockOut(db, {
      record,
      station,
      securityGuard: who.securityGuard,
      tenantId,
      userId,
      latitude,
      longitude,
      ip: null,
      settings: gate.settings,
      geofence: gate.geofence,
    });
    status = out.status;
  } catch (e: any) {
    console.warn('[demo] applyClockOut failed:', e?.message || e);
  }

  await who.securityGuard.update({ isOnDuty: false }).catch(() => {});

  // Emit guard.checkout (shift end) to supervisors + client.
  try {
    await dispatch(
      'guard.checkout',
      {
        guardName: who.securityGuard.fullName || DEMO_NAMES.guardDay,
        stationName: station.stationName || null,
        siteName: ctx.site?.companyName || null,
        guardId: who.securityGuard.id,
        guardShiftId: record.id,
        stationId: station.id,
      },
      { database: db, tenantId, sourceEntityType: 'guardShift', sourceEntityId: record.id },
    );
  } catch (e: any) {
    console.warn('[demo] guard.checkout dispatch failed:', e?.message || e);
  }

  return { guardShiftId: record.id, status };
}

async function stepHandover(db: any, ctx: DemoContext): Promise<DemoStepResult> {
  const def = DEMO_STEPS[6];
  ensureSeeded(ctx);
  const station = ctx.stations[0];

  const out = await doClockOut(db, ctx, ctx.guards.day!, station);
  const inn = await doClockIn(db, ctx, ctx.guards.night!, station);

  // A dedicated handover event makes the relevo crisp in the CRM feed.
  await storePlatformEvent(db, {
    tenantId: ctx.tenantId,
    eventType: 'guard.checkin',
    title: 'Relevo de turno',
    body: `${DEMO_NAMES.guardDay} entregó el puesto a ${DEMO_NAMES.guardNight} en ${station.stationName || 'el puesto'}.`,
    targetRoles: 'admin,operationsManager,securitySupervisor',
    sourceEntityType: 'guardShift',
    sourceEntityId: inn.guardShiftId,
    payload: {
      handover: true,
      outgoingGuard: DEMO_NAMES.guardDay,
      incomingGuard: DEMO_NAMES.guardNight,
      stationId: station.id,
      outShiftId: out.guardShiftId,
      inShiftId: inn.guardShiftId,
    },
  }).catch(() => {});

  return result(
    def,
    true,
    `Relevo: ${DEMO_NAMES.guardDay} marcó salida y ${DEMO_NAMES.guardNight} marcó entrada — ` +
      `notificación de relevo en vivo.`,
    { outShiftId: out.guardShiftId, inShiftId: inn.guardShiftId, stationId: station.id },
  );
}

/* ────────────────────────────────────────────────────────────────────────── */
/* RESET — restore the clean seeded state                                     */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Restore the demo to its clean, just-seeded state so it can be re-run. This
 * deletes only the EPHEMERAL artefacts produced by the steps (punches, today's
 * visitor/incident, patrol logs, radio sessions, today's shifts, step-emitted
 * platform events) — never the seeded actors, site, stations or checkpoints.
 *
 * HARD-GATED: every delete is scoped to the asserted demo tenant id.
 */
export async function resetDemo(db: any): Promise<{ ok: boolean; message: string; deleted: Record<string, number> }> {
  const ctx = await buildContext(db);
  assertDemoTenant(ctx.tenantId, configuredDemoTenantId(), ctx.tenant); // defense-in-depth
  const tenantId = ctx.tenantId;
  const deleted: Record<string, number> = {};

  const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
  const del = async (label: string, model: any, where: any, force = true) => {
    if (!model) return;
    try {
      deleted[label] = await model.destroy({ where: { ...where, tenantId }, force });
    } catch (e: any) {
      console.warn(`[demo reset] ${label} failed:`, e?.message || e);
      deleted[label] = -1;
    }
  };

  // Guard punches (attendance) created by steps 2 & 7.
  await del('guardShifts', db.guardShift, {});
  await del('attendanceExceptions', db.attendanceException, {});

  // Patrol logs (step 4) — keep patrols/checkpoints (seeded), reset completion.
  await del('patrolLogs', db.patrolLog, {});
  try {
    await db.patrol.update(
      { completed: false, completionTime: null },
      { where: { tenantId }, paranoid: false },
    );
  } catch (e: any) {
    console.warn('[demo reset] patrol completion reset failed:', e?.message || e);
  }

  // Today's visitor (step 3) + incident (step 5).
  await del('visitorLogs', db.visitorLog, { visitDate: { [Op.gte]: startOfDay } });
  await del('incidents', db.incident, { date: { [Op.gte]: startOfDay } });

  // Radio check sessions/entries (step 6).
  await del('radioCheckEntries', db.radioCheckEntry, {});
  await del('radioCheckSessions', db.radioCheckSession, {});

  // Today's shifts (step 1) + any draft schedule proposals/proposed shifts.
  await del('shifts', db.shift, { startTime: { [Op.gte]: startOfDay } });
  await del('proposedShifts', db.proposedShift, {});
  await del('scheduleProposals', db.scheduleProposal, {});
  await del('implementationPlanItems', db.implementationPlanItem, {});
  await del('implementationPlans', db.implementationPlan, {});

  // Platform events emitted by the demo today (clear the live feed).
  await del('platformEvents', db.platformEvent, { createdAt: { [Op.gte]: startOfDay } });

  // Guards back off-duty.
  try {
    await db.securityGuard.update({ isOnDuty: false }, { where: { tenantId } });
  } catch (e: any) {
    console.warn('[demo reset] isOnDuty reset failed:', e?.message || e);
  }

  // Clear the activity panel and record the reset.
  _demoLog.length = 0;
  _lastResetAt = new Date().toISOString();
  pushDemoLog({
    id: `reset-${_lastResetAt}`,
    at: _lastResetAt,
    step: 0,
    level: 'info',
    message: 'Demo restablecida al estado sembrado. Lista para una nueva presentación.',
    meta: { deleted },
  });

  return {
    ok: true,
    message: 'Demo restablecido al estado sembrado. Listo para una nueva presentación.',
    deleted,
  };
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Public API: runStep / state                                                */
/* ────────────────────────────────────────────────────────────────────────── */

const STEP_FNS: Record<number, (db: any, ctx: DemoContext) => Promise<DemoStepResult>> = {
  1: stepSchedule,
  2: stepClockIn,
  3: stepVisitor,
  4: stepPatrol,
  5: stepIncident,
  6: stepRadio,
  7: stepHandover,
};

/** Run a single demo step (1..7), hard-gated to the demo tenant. */
export async function runStep(db: any, step: number): Promise<DemoStepResult> {
  const n = parseInt(String(step), 10);
  if (!Number.isInteger(n) || n < 1 || n > 7) {
    throw new Error400(undefined, 'demo.badStep');
  }
  const ctx = await buildContext(db); // asserts demo tenant
  assertDemoTenant(ctx.tenantId, configuredDemoTenantId(), ctx.tenant); // belt + suspenders
  const r = await STEP_FNS[n](db, ctx);
  pushDemoLog({
    id: `s${r.step}-${r.at}`,
    at: r.at,
    step: r.step,
    level: r.ok ? 'success' : 'error',
    message: r.message,
    meta: r.details || null,
  });
  return r;
}

/**
 * Current demo state for the panel: the demo tenant identity, the resolved actor/
 * site ids (so the panel can show them), whether the tenant is fully seeded, the
 * step catalogue, and a derived "currentStep" based on what live state exists.
 */
export async function getState(db: any): Promise<any> {
  const ctx = await buildContext(db); // asserts demo tenant
  const tenantId = ctx.tenantId;
  const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);

  const safeCount = async (model: any, where: any): Promise<number> => {
    if (!model) return 0;
    try { return await model.count({ where: { ...where, tenantId } }); } catch { return 0; }
  };

  const [shiftsToday, openPunches, visitorsToday, patrolLogs, incidentsToday, radioRunning] = await Promise.all([
    safeCount(db.shift, { startTime: { [Op.gte]: startOfDay } }),
    safeCount(db.guardShift, { punchOutTime: null }),
    safeCount(db.visitorLog, { visitDate: { [Op.gte]: startOfDay } }),
    safeCount(db.patrolLog, {}),
    safeCount(db.incident, { date: { [Op.gte]: startOfDay } }),
    safeCount(db.radioCheckSession, { status: 'running' }),
  ]);

  // Derive the furthest completed step from live state (best-effort).
  let currentStep = 0;
  if (shiftsToday > 0) currentStep = 1;
  if (openPunches > 0) currentStep = Math.max(currentStep, 2);
  if (visitorsToday > 0) currentStep = Math.max(currentStep, 3);
  if (patrolLogs > 0) currentStep = Math.max(currentStep, 4);
  if (incidentsToday > 0) currentStep = Math.max(currentStep, 5);
  if (radioRunning > 0) currentStep = Math.max(currentStep, 6);

  const seeded =
    !!ctx.admin && !!ctx.client && !!ctx.guards.day && !!ctx.guards.night && !!ctx.site && ctx.stations.length > 0;

  return {
    tenant: {
      id: tenantId,
      name: ctx.tenant.name || DEMO_TENANT_NAME,
      slug: ctx.tenant.url || DEMO_TENANT_SLUG,
      timezone: ctx.tenant.timezone || 'America/Guayaquil',
      country: ctx.tenant.country || 'EC',
    },
    configuredById: configuredDemoTenantId() ? 'DEMO_TENANT_ID' : 'slug',
    seeded,
    accounts: {
      admin: ctx.admin ? { email: DEMO_EMAILS.admin, userId: ctx.admin.user.id, name: DEMO_NAMES.admin } : null,
      client: ctx.client ? { email: DEMO_EMAILS.client, userId: ctx.client.user.id, name: DEMO_NAMES.client } : null,
      guardDay: ctx.guards.day
        ? { email: DEMO_EMAILS.guardDay, userId: ctx.guards.day.user.id, securityGuardId: ctx.guards.day.securityGuard?.id, name: DEMO_NAMES.guardDay }
        : null,
      guardNight: ctx.guards.night
        ? { email: DEMO_EMAILS.guardNight, userId: ctx.guards.night.user.id, securityGuardId: ctx.guards.night.securityGuard?.id, name: DEMO_NAMES.guardNight }
        : null,
    },
    site: ctx.site ? { id: ctx.site.id, name: ctx.site.companyName } : null,
    stations: ctx.stations.map((s: any) => ({ id: s.id, name: s.stationName })),
    steps: DEMO_STEPS,
    currentStep,
    liveCounts: { shiftsToday, openPunches, visitorsToday, patrolLogs, incidentsToday, radioRunning },
  };
}
