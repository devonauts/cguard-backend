/**
 * Alarm ingest pipeline — the heart of central-station processing.
 *
 * `ingestSignal(db, tenantId, sig)` takes a raw, already-decoded signal
 * (from the webhook handler, the manual handler, the TCP/UDP receiver or an
 * internal bridge) and:
 *
 *   1) resolves the alarmPanel (by id, or by accountNumber + tenantId);
 *   2) persists the immutable alarmSignal row;
 *   3) maps the event code -> { category, priority, description } via codes.ts;
 *   4) suppresses "runaway" duplicates (same panel+zone+code within 60s);
 *   5) finds an OPEN alarmCase for the panel inside a grouping window (30 min),
 *      or creates a new one;
 *   6) creates the alarmEvent linked to that case; updates the panel status /
 *      lastSignalAt;
 *   7) appends an alarmAuditLog entry.
 *
 * Returns { case, event, signal, suppressed }.
 *
 * NOTE: this module performs DB writes via the Sequelize `db` (req.database or
 * the standalone receiver's models). It is intentionally framework-agnostic so
 * the same code path serves HTTP handlers and the raw socket receiver.
 */

import { Op } from 'sequelize';
import { mapCode, MappedCode } from './codes';
import { emitAlarmEvent } from './realtime';

/** Input accepted by ingestSignal. */
export interface IngestSignalInput {
  alarmPanelId?: string | null;
  accountNumber?: string | null;
  zoneNumber?: string | null;
  partition?: string | null;
  /** sia | contactid | surgard | webhook | manual */
  format?: string | null;
  eventCode?: string | null;
  /** event | restore | status (or raw protocol qualifier 1/3/6, E/R/S) */
  qualifier?: string | null;
  raw?: string | null;
  /** ip | cellular | receiver */
  channel?: string | null;
  receiverId?: string | null;
  receivedAt?: Date | null;
  /** for manual ingest we may already know the case fields */
  category?: string | null;
  priority?: number | null;
  description?: string | null;
}

export interface IngestResult {
  case: any | null;
  event: any | null;
  signal: any;
  /** true when collapsed into a recent identical signal (runaway suppression) */
  suppressed: boolean;
}

/** Grouping window: signals from a panel within this window join one case. */
const CASE_GROUPING_WINDOW_MS = 30 * 60 * 1000; // 30 minutes
/** Runaway window: identical panel+zone+code inside this collapses. */
const RUNAWAY_WINDOW_MS = 60 * 1000; // 60 seconds

/** Case statuses considered "open" (still actionable). */
const OPEN_CASE_STATUSES = ['queued', 'acknowledged', 'verifying', 'dispatched'];

/** Categories that should NOT, on their own, open/escalate an operator case. */
const NON_CASE_CATEGORIES = new Set(['restore', 'openclose', 'test', 'supervisory']);

/** Normalize a protocol qualifier into our vocabulary: event|restore|status. */
function normalizeQualifier(q?: string | null): string {
  if (!q) return 'event';
  const s = String(q).trim().toLowerCase();
  if (s === 'restore' || s === '3' || s === 'r') return 'restore';
  if (s === 'status' || s === '6' || s === 's' || s === 'p') return 'status';
  return 'event';
}

/** Panel status hint from the mapped category + qualifier. */
function panelStatusFor(category: string, qualifier: string): string | null {
  if (category === 'openclose') {
    // Heuristic: an "opening" (disarm) vs "closing" (arm). We cannot always
    // tell direction from the category alone, so leave to event description.
    return null;
  }
  if (qualifier === 'restore' || category === 'restore') return 'online';
  return null;
}

/**
 * Resolve the alarm panel either by explicit id or by accountNumber.
 * Always scoped to tenantId. Returns null if not found.
 */
async function resolvePanel(
  db: any,
  tenantId: string,
  input: IngestSignalInput,
): Promise<any | null> {
  if (input.alarmPanelId) {
    return db.alarmPanel.findOne({
      where: { id: input.alarmPanelId, tenantId },
    });
  }
  if (input.accountNumber) {
    return db.alarmPanel.findOne({
      where: { accountNumber: String(input.accountNumber), tenantId },
    });
  }
  return null;
}

/**
 * Cross-tenant panel lookup by account number — used by the receiver, which
 * gets a raw signal carrying only the central-station account and must
 * discover which tenant owns it. Returns the panel (with its tenantId) or null.
 */
export async function resolvePanelByAccount(
  db: any,
  accountNumber: string,
): Promise<any | null> {
  if (!accountNumber) return null;
  return db.alarmPanel.findOne({
    where: { accountNumber: String(accountNumber) },
  });
}

/** Build a short, human title for a freshly opened case. */
function caseTitle(panelName: string, mapped: MappedCode, zoneNumber?: string | null): string {
  const z = zoneNumber ? ` (zona ${zoneNumber})` : '';
  return `${mapped.description}${z} — ${panelName}`;
}

/**
 * Ingest a single decoded signal. See module docstring for the pipeline.
 */
export async function ingestSignal(
  db: any,
  tenantId: string,
  sig: IngestSignalInput,
): Promise<IngestResult> {
  const now = sig.receivedAt ? new Date(sig.receivedAt) : new Date();
  const qualifier = normalizeQualifier(sig.qualifier);

  // (1) resolve the panel.
  const panel = await resolvePanel(db, tenantId, sig);
  const alarmPanelId = panel ? panel.id : sig.alarmPanelId || null;
  const accountNumber = sig.accountNumber || (panel ? panel.accountNumber : null);

  // (3) map the event code. Manual ingest may pass category/priority directly.
  let mapped: MappedCode;
  if (sig.category) {
    mapped = {
      category: sig.category as any,
      priority: typeof sig.priority === 'number' ? sig.priority : 3,
      description: sig.description || sig.category,
    };
  } else {
    mapped = mapCode(sig.format || '', sig.eventCode || '', qualifier);
    if (sig.description) mapped = { ...mapped, description: sig.description };
    if (typeof sig.priority === 'number') mapped = { ...mapped, priority: sig.priority };
  }

  // (2) persist the immutable signal FIRST (so nothing is lost even if the
  //     downstream case/event logic throws).
  const signal = await db.alarmSignal.create({
    alarmPanelId,
    accountNumber: accountNumber ? String(accountNumber) : null,
    zoneNumber: sig.zoneNumber || null,
    partition: sig.partition || null,
    format: sig.format || null,
    eventCode: sig.eventCode || null,
    qualifier,
    raw: sig.raw || null,
    channel: sig.channel || null,
    receiverId: sig.receiverId || null,
    receivedAt: now,
    tenantId,
  });

  // If we could not resolve a panel there is nothing to correlate against;
  // the signal is still recorded for audit/troubleshooting.
  if (!panel) {
    return { case: null, event: null, signal, suppressed: false };
  }

  // (4) runaway suppression — same panel + zone + eventCode within 60s.
  const runawaySince = new Date(now.getTime() - RUNAWAY_WINDOW_MS);
  const recentDup = await db.alarmSignal.findOne({
    where: {
      tenantId,
      alarmPanelId,
      zoneNumber: sig.zoneNumber || null,
      eventCode: sig.eventCode || null,
      id: { [Op.ne]: signal.id },
      receivedAt: { [Op.gte]: runawaySince },
    },
    order: [['receivedAt', 'DESC']],
  });

  // Always touch panel state on any traffic.
  const panelUpdate: any = { lastSignalAt: now };
  const statusHint = panelStatusFor(mapped.category, qualifier);
  if (statusHint) panelUpdate.status = statusHint;
  await panel.update(panelUpdate);

  if (recentDup) {
    // Collapse: do NOT create a new case/event. Attach an audit note to the
    // currently-open case (if any) so operators can see the runaway count.
    const openCase = await findOpenCase(db, tenantId, alarmPanelId, now);
    if (openCase) {
      await db.alarmAuditLog.create({
        alarmCaseId: openCase.id,
        action: 'signal.runaway_suppressed',
        detail: `Señal repetida (${mapped.description}) suprimida por runaway: panel=${alarmPanelId} zona=${sig.zoneNumber || '-'} code=${sig.eventCode || '-'}`,
        actorId: null,
        at: now,
        tenantId,
      });
    }
    return { case: openCase || null, event: null, signal, suppressed: true };
  }

  // Restores / open-close / test / supervisory: record the event, attach to an
  // open case if one exists, but do not OPEN a new operator case on their own.
  const shouldOpenCase = !NON_CASE_CATEGORIES.has(mapped.category);

  // (5) find an open case in the grouping window, or create one.
  let alarmCase = await findOpenCase(db, tenantId, alarmPanelId, now);
  let createdCase = false;
  if (!alarmCase && shouldOpenCase) {
    alarmCase = await db.alarmCase.create({
      alarmPanelId,
      status: 'queued',
      priority: mapped.priority,
      category: mapped.category,
      title: caseTitle(panel.name, mapped, sig.zoneNumber),
      postSiteId: panel.postSiteId || null,
      stationId: panel.stationId || null,
      customerId: panel.customerId || null,
      tenantId,
      createdById: null,
    });
    createdCase = true;
  } else if (alarmCase && shouldOpenCase) {
    // Escalate the open case's priority if this event is more severe
    // (lower number = higher priority).
    if (mapped.priority < alarmCase.priority) {
      await alarmCase.update({ priority: mapped.priority });
    }
  }

  // (6) create the alarmEvent linked to the case (case may be null for a bare
  //     restore with no open case — still record the event for history).
  const alarmZoneId = await resolveZoneId(db, tenantId, alarmPanelId, sig.zoneNumber);
  const event = await db.alarmEvent.create({
    alarmSignalId: signal.id,
    alarmPanelId,
    alarmZoneId,
    category: mapped.category,
    priority: mapped.priority,
    description: mapped.description,
    zoneNumber: sig.zoneNumber || null,
    at: now,
    alarmCaseId: alarmCase ? alarmCase.id : null,
    tenantId,
  });

  // (7) audit log.
  if (alarmCase) {
    await db.alarmAuditLog.create({
      alarmCaseId: alarmCase.id,
      action: createdCase ? 'case.opened' : 'event.appended',
      detail: createdCase
        ? `Caso abierto por ${mapped.description} (${sig.format || '?'}/${sig.eventCode || '?'})`
        : `Evento añadido: ${mapped.description} (${sig.format || '?'}/${sig.eventCode || '?'})`,
      actorId: null,
      at: now,
      tenantId,
    });
  }

  // (8) real-time push to operator consoles (SSE + socket.io).
  if (alarmCase) {
    await emitAlarmEvent(db, tenantId, {
      eventType: createdCase ? 'alarm.case.new' : 'alarm.case.updated',
      title: createdCase ? `Nueva alarma: ${mapped.description}` : `Actualización: ${mapped.description}`,
      body: `${panel.name}${sig.zoneNumber ? ' · zona ' + sig.zoneNumber : ''}`,
      caseId: alarmCase.id,
      payload: { priority: alarmCase.priority, category: alarmCase.category, panelName: panel.name },
    });
  }

  // (9) Video verification — if the triggering zone has a linked camera and the
  // alarm is verifiable, auto-capture a verification clip linked to the case.
  if (alarmCase && alarmZoneId) {
    try { await maybeCreateVerificationClip(db, tenantId, alarmCase, alarmZoneId, mapped, now); }
    catch (e: any) { console.warn('[alarm] verification clip failed:', e?.message || e); }
  }

  return { case: alarmCase || null, event, signal, suppressed: false };
}

const VERIFIABLE = ['burglary', 'holdup', 'panic', 'fire', 'medical', 'tamper'];

/** Auto-capture a verification clip for an alarm case when its zone is linked to
 *  a camera. Deduped to one clip per camera per case. Best-effort. */
async function maybeCreateVerificationClip(
  db: any, tenantId: string, alarmCase: any, alarmZoneId: string, mapped: MappedCode, at: Date,
): Promise<void> {
  if (!VERIFIABLE.includes(mapped.category)) return;
  const zone = await db.alarmZone.findByPk(alarmZoneId);
  if (!zone || !zone.linkedCameraId) return;
  const existing = await db.videoClip.findOne({
    where: { alarmCaseId: alarmCase.id, videoCameraId: zone.linkedCameraId },
  });
  if (existing) return;
  const start = new Date(at.getTime() - 30000);
  const end = new Date(at.getTime() + 30000);
  await db.videoClip.create({
    videoCameraId: zone.linkedCameraId,
    alarmCaseId: alarmCase.id,
    startAt: start,
    endAt: end,
    durationSec: 60,
    label: `Verificación: ${mapped.description}`,
    status: 'pending',
    tenantId,
  });
  await db.alarmAuditLog.create({
    alarmCaseId: alarmCase.id,
    action: 'video.verification',
    detail: 'Clip de verificación capturado (cámara vinculada a la zona)',
    actorId: null,
    at: new Date(),
    tenantId,
  });
}

/**
 * Find an OPEN case for the panel inside the grouping window. Most-recent first.
 */
async function findOpenCase(
  db: any,
  tenantId: string,
  alarmPanelId: string | null,
  now: Date,
): Promise<any | null> {
  if (!alarmPanelId) return null;
  const windowStart = new Date(now.getTime() - CASE_GROUPING_WINDOW_MS);
  return db.alarmCase.findOne({
    where: {
      tenantId,
      alarmPanelId,
      status: { [Op.in]: OPEN_CASE_STATUSES },
      createdAt: { [Op.gte]: windowStart },
    },
    order: [['createdAt', 'DESC']],
  });
}

/**
 * Best-effort resolution of a zone row by panel + zoneNumber, scoped to tenant.
 * Returns the alarmZone id or null.
 */
async function resolveZoneId(
  db: any,
  tenantId: string,
  alarmPanelId: string | null,
  zoneNumber?: string | null,
): Promise<string | null> {
  if (!alarmPanelId || !zoneNumber) return null;
  try {
    const zone = await db.alarmZone.findOne({
      where: { tenantId, alarmPanelId, zoneNumber: String(zoneNumber) },
      attributes: ['id'],
    });
    return zone ? zone.id : null;
  } catch {
    return null;
  }
}

export default { ingestSignal, resolvePanelByAccount };
