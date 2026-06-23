/**
 * Radio Check engine (pase de novedades) — Phase 1, app channel.
 *
 * Tenant isolation is MANUAL and mandatory: every query filters tenantId. The DB
 * is the source of truth; FCM (to guards, via the channel adapter) and socket.io
 * (to the CRM, via storePlatformEvent) are best-effort nudges. A session is a
 * roll call that advances station-by-station: one entry is `notified` at a time,
 * and either the guard replies or the per-station timeout promotes the next one.
 *
 * The CONTROLLER is the trust boundary — a guard reply's identity comes from
 * req.currentUser.id, never the body.
 */
import { storePlatformEvent } from '../lib/platformEventStore';
import { broadcastPcm } from '../lib/radioVoice';
import { getChannelAdapter } from './radio/channelAdapter';
import { classifyText } from './radio/classify';
import * as ai from './radioCheckAiService';

const DISPATCHER_TARGET_ROLES = 'admin,operationsManager,securitySupervisor,dispatcher';
const DEFAULT_PROMPT = 'Reporte de novedades del puesto. ¿Alguna novedad o incidente?';

type Scope = 'all' | 'station';

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export async function getSettings(db: any, tenantId: string): Promise<any> {
  let s = await db.radioCheckSettings.findOne({ where: { tenantId, deletedAt: null } });
  if (!s) {
    s = await db.radioCheckSettings.create({ tenantId, promptText: DEFAULT_PROMPT });
  }
  return s;
}

export async function upsertSettings(db: any, tenantId: string, patch: any, userId?: string): Promise<any> {
  const s = await getSettings(db, tenantId);
  const allowed = ['enabled', 'intervalMinutes', 'perStationTimeoutSeconds', 'activeHoursStart', 'activeHoursEnd', 'promptText', 'voiceAnnouncement', 'channel'];
  const next: any = { updatedById: userId || null };
  for (const k of allowed) if (patch[k] !== undefined) next[k] = patch[k];
  if (next.intervalMinutes != null) next.intervalMinutes = Math.max(1, Math.min(720, parseInt(next.intervalMinutes, 10) || 35));
  if (next.perStationTimeoutSeconds != null) next.perStationTimeoutSeconds = Math.max(30, Math.min(1800, parseInt(next.perStationTimeoutSeconds, 10) || 180));
  await s.update(next);
  return s;
}

// ---------------------------------------------------------------------------
// Resolution helpers
// ---------------------------------------------------------------------------

/** Stations in scope, each with its currently on-duty assigned guards. */
async function resolveStationsForCheck(db: any, tenantId: string, scope: Scope, stationId?: string): Promise<Array<{ station: any; guards: Array<{ userId: string; securityGuardId: string; name: string }> }>> {
  const { Op } = db.Sequelize;
  const where: any = { tenantId, deletedAt: null };
  if (scope === 'station' && stationId) where.id = stationId;
  const stations = await db.station.findAll({
    where,
    attributes: ['id', 'stationName'],
    include: [{ model: db.user, as: 'assignedGuards', attributes: ['id'], through: { attributes: [] }, required: false }],
    order: [['stationName', 'ASC']],
  });
  const out: any[] = [];
  for (const st of stations) {
    const userIds = (st.assignedGuards || []).map((u: any) => u.id).filter(Boolean);
    let guards: any[] = [];
    if (userIds.length) {
      const sgs = await db.securityGuard.findAll({
        where: { tenantId, deletedAt: null, isOnDuty: true, guardId: { [Op.in]: userIds } },
        attributes: ['id', 'guardId', 'fullName'],
      });
      guards = sgs.map((sg: any) => ({ userId: sg.guardId, securityGuardId: sg.id, name: sg.fullName || 'Guardia' }));
    }
    out.push({ station: st, guards });
  }
  return out;
}

/** The station ids a guard (user.id) is assigned to — used to authorize replies. */
async function guardStationIds(db: any, tenantId: string, userId: string): Promise<string[]> {
  const stations = await db.station.findAll({
    where: { tenantId, deletedAt: null },
    attributes: ['id'],
    include: [{ model: db.user, as: 'assignedGuards', attributes: [], where: { id: userId }, through: { attributes: [] }, required: true }],
  });
  return stations.map((s: any) => s.id);
}

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

export async function startSession(db: any, tenantId: string, opts: { mode: 'manual' | 'auto'; initiatedByUserId?: string | null; scope: Scope; stationId?: string }): Promise<any> {
  const settings = await getSettings(db, tenantId);
  const prompt = settings.promptText || DEFAULT_PROMPT;
  const stations = await resolveStationsForCheck(db, tenantId, opts.scope, opts.stationId);
  if (!stations.length) { const e: any = new Error('No hay puestos para el pase de novedades'); e.code = 400; throw e; }

  const now = new Date();
  const session = await db.radioCheckSession.create({
    tenantId, mode: opts.mode, initiatedByUserId: opts.initiatedByUserId || null,
    scope: opts.scope, status: 'running', startedAt: now,
    summaryStatus: 'pending', totalStations: stations.length,
    createdById: opts.initiatedByUserId || null,
  });

  let seq = 0;
  for (const { station, guards } of stations) {
    const primary = guards[0] || null;
    const noGuard = guards.length === 0;
    await db.radioCheckEntry.create({
      tenantId, sessionId: session.id, stationId: station.id,
      stationName: station.stationName,
      guardUserId: primary?.userId || null,
      guardSecurityGuardId: primary?.securityGuardId || null,
      guardName: primary?.name || null,
      seq: seq++,
      status: noGuard ? 'skipped' : 'pending',
      promptText: prompt,
      transcriptStatus: 'skipped',
      classification: 'unknown',
      notifiedAt: null,
      timeoutAt: null,
    });
  }

  await storePlatformEvent(db, {
    tenantId, eventType: 'radio.session_started',
    title: 'Pase de novedades iniciado',
    body: `${stations.length} puesto(s)`,
    targetRoles: DISPATCHER_TARGET_ROLES,
    sourceEntityType: 'radioCheckSession', sourceEntityId: session.id,
    payload: { sessionId: session.id, mode: opts.mode, totalStations: stations.length },
  }).catch(() => {});

  // Speak ONE opening announcement to everyone, then open a single 60-second
  // window for ALL stations to report at once (instead of calling them one by
  // one). The scheduler/advanceSession then expires anyone who didn't reply.
  await notifyAllEntries(db, tenantId, session.id, RADIO_REPORT_WINDOW_SECONDS);
  return db.radioCheckSession.findOne({ where: { id: session.id, tenantId } });
}

/** Seconds guards have to complete their report after the opening announcement. */
const RADIO_REPORT_WINDOW_SECONDS = 60;

/**
 * Announcement model: the AI specialist speaks the opening line into the live
 * channel, then EVERY station is notified simultaneously with the same deadline.
 * The worker app shows a countdown to `timeoutAt`.
 */
async function notifyAllEntries(db: any, tenantId: string, sessionId: string, windowSeconds: number): Promise<void> {
  const now = new Date();
  const timeoutAt = new Date(now.getTime() + windowSeconds * 1000);

  // ONE voice only: the AI speaks the opening LIVE on the radio channel. We do
  // NOT also attach an auto-play mp3 (promptAudioUrl) — doing both made the
  // dispatcher/guard hear the announcement twice (channel + mp3). The live
  // broadcast is the single source of the spoken announcement.
  void ai.broadcastOpening(tenantId);

  const pending = await db.radioCheckEntry.findAll({
    where: { tenantId, sessionId, status: 'pending', deletedAt: null },
    order: [['seq', 'ASC']],
  });
  const adapter = getChannelAdapter();

  for (const entry of pending) {
    const [claimed] = await db.radioCheckEntry.update(
      { status: 'notified', notifiedAt: now, timeoutAt, promptAudioUrl: null },
      { where: { id: entry.id, tenantId, status: 'pending' } },
    );
    if (!claimed) continue;

    const stations = await resolveStationsForCheck(db, tenantId, 'station', entry.stationId);
    const guards = stations[0]?.guards || [];
    const userIds = guards.map((g: any) => g.userId).filter(Boolean);
    await adapter.notifyGuards({ db, tenantId }, userIds, {
      sessionId, entryId: entry.id, stationId: entry.stationId,
      stationName: entry.stationName || '', promptText: entry.promptText || DEFAULT_PROMPT,
      promptAudioUrl: null,
    }).catch(() => {});

    await storePlatformEvent(db, {
      tenantId, eventType: 'radio.station_notified', title: 'Llamando a puesto', body: entry.stationName || '',
      targetRoles: DISPATCHER_TARGET_ROLES, sourceEntityType: 'radioCheckEntry', sourceEntityId: entry.id,
      payload: { sessionId, entryId: entry.id, stationId: entry.stationId, stationName: entry.stationName, seq: entry.seq, promptAudioUrl: null, timeoutAt: timeoutAt.toISOString() },
    }).catch(() => {});
  }
}

/** Mark an entry notified, set its timeout, push to its station's on-duty guards. */
async function notifyEntry(db: any, tenantId: string, entry: any, perStationTimeoutSeconds: number): Promise<void> {
  const now = new Date();
  const timeoutAt = new Date(now.getTime() + perStationTimeoutSeconds * 1000);
  // Idempotent claim: only the worker that flips pending→notified proceeds.
  const [claimed] = await db.radioCheckEntry.update(
    { status: 'notified', notifiedAt: now, timeoutAt },
    { where: { id: entry.id, tenantId, status: 'pending' } },
  );
  if (!claimed) return;

  // Voice the call: synthesize the AI dispatcher's spoken prompt for this station
  // and persist it so both the guard app and the dispatcher (CRM) can play it.
  const spokenPrompt = ai.buildStationPromptText(entry.stationName);
  const promptAudioUrl = await ai.synthesizeSpeech(
    `radio-check/${tenantId}/${entry.sessionId}/prompt-${entry.id}.mp3`,
    spokenPrompt,
  );
  if (promptAudioUrl) {
    await db.radioCheckEntry.update({ promptAudioUrl }, { where: { id: entry.id, tenantId } }).catch(() => {});
  }

  // TRANSMIT the call over the live radio channel so on-duty guards HEAR the AI
  // dispatcher on their already-connected channel (no app rebuild, no autoplay
  // block). Fire-and-forget so it never blocks the roll-call advance.
  void (async () => {
    try {
      const pcm = await ai.synthesizeSpeechPcm(spokenPrompt);
      if (pcm) await broadcastPcm(tenantId, pcm, ai.OPENAI_PCM_RATE, 'Central de monitoreo');
    } catch (e: any) {
      console.warn('[radioCheck] channel broadcast failed:', e?.message || e);
    }
  })();

  // Re-resolve on-duty guards for the station (rotation-tolerant) and push to all.
  const stations = await resolveStationsForCheck(db, tenantId, 'station', entry.stationId);
  const guards = stations[0]?.guards || [];
  const userIds = guards.map((g: any) => g.userId).filter(Boolean);
  const adapter = getChannelAdapter();
  await adapter.notifyGuards({ db, tenantId }, userIds, {
    sessionId: entry.sessionId, entryId: entry.id, stationId: entry.stationId,
    stationName: entry.stationName || '', promptText: entry.promptText || DEFAULT_PROMPT,
    promptAudioUrl: promptAudioUrl || null,
  }).catch(() => {});

  await storePlatformEvent(db, {
    tenantId, eventType: 'radio.station_notified',
    title: 'Llamando a puesto',
    body: entry.stationName || '',
    targetRoles: DISPATCHER_TARGET_ROLES,
    sourceEntityType: 'radioCheckEntry', sourceEntityId: entry.id,
    payload: { sessionId: entry.sessionId, entryId: entry.id, stationId: entry.stationId, stationName: entry.stationName, seq: entry.seq, promptAudioUrl: promptAudioUrl || null },
  }).catch(() => {});
}

/**
 * Drive the roll call: time out the current `notified` entry if its window passed,
 * then notify the next `pending` entry; if none remain, complete the session.
 * Safe to call from the scheduler (any worker) and after each reply — every state
 * transition is an idempotent conditional UPDATE.
 */
export async function advanceSession(db: any, tenantId: string, sessionId: string): Promise<void> {
  const { Op } = db.Sequelize;
  const session = await db.radioCheckSession.findOne({ where: { id: sessionId, tenantId, deletedAt: null } });
  if (!session || session.status !== 'running') return;
  const settings = await getSettings(db, tenantId);

  // 1) Expire a timed-out notified entry.
  const now = new Date();
  const stale = await db.radioCheckEntry.findOne({
    where: { tenantId, sessionId, status: 'notified', timeoutAt: { [Op.lt]: now }, deletedAt: null },
  });
  if (stale) {
    const [expired] = await db.radioCheckEntry.update(
      { status: 'no_response' },
      { where: { id: stale.id, tenantId, status: 'notified' } },
    );
    if (expired) {
      await session.increment('noResponseCount').catch(() => {});
      await storePlatformEvent(db, {
        tenantId, eventType: 'radio.no_response', title: 'Sin respuesta', body: stale.stationName || '',
        targetRoles: DISPATCHER_TARGET_ROLES, sourceEntityType: 'radioCheckEntry', sourceEntityId: stale.id,
        payload: { sessionId, entryId: stale.id, stationId: stale.stationId, stationName: stale.stationName },
      }).catch(() => {});
    }
  }

  // 2) If a station is currently notified and still within its window, wait.
  const active = await db.radioCheckEntry.findOne({ where: { tenantId, sessionId, status: 'notified', deletedAt: null } });
  if (active) return;

  // 3) Notify the next pending station.
  const next = await db.radioCheckEntry.findOne({
    where: { tenantId, sessionId, status: 'pending', deletedAt: null },
    order: [['seq', 'ASC']],
  });
  if (next) { await notifyEntry(db, tenantId, next, settings.perStationTimeoutSeconds); return; }

  // 4) Nothing pending and nothing notified → complete.
  await completeSession(db, tenantId, sessionId);
}

export async function completeSession(db: any, tenantId: string, sessionId: string): Promise<void> {
  const [done] = await db.radioCheckSession.update(
    { status: 'completed', completedAt: new Date() },
    { where: { id: sessionId, tenantId, status: 'running' } },
  );
  if (!done) return;
  await storePlatformEvent(db, {
    tenantId, eventType: 'radio.session_completed', title: 'Pase de novedades finalizado', body: '',
    targetRoles: DISPATCHER_TARGET_ROLES, sourceEntityType: 'radioCheckSession', sourceEntityId: sessionId,
    payload: { sessionId },
  }).catch(() => {});
  // Best-effort roll-call summary (no-op if no OPENAI_API_KEY).
  ai.generateSummary(db, tenantId, sessionId).catch(() => {});
}

export async function cancelSession(db: any, tenantId: string, sessionId: string): Promise<void> {
  await db.radioCheckSession.update(
    { status: 'cancelled', completedAt: new Date() },
    { where: { id: sessionId, tenantId, status: 'running' } },
  );
  await storePlatformEvent(db, {
    tenantId, eventType: 'radio.session_completed', title: 'Pase de novedades cancelado', body: '',
    targetRoles: DISPATCHER_TARGET_ROLES, sourceEntityType: 'radioCheckSession', sourceEntityId: sessionId,
    payload: { sessionId, cancelled: true },
  }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Guard reply
// ---------------------------------------------------------------------------

const CANNED_SIN_NOVEDAD = 'Sin novedad';

export async function getPendingForGuard(db: any, tenantId: string, userId: string): Promise<any | null> {
  const { Op } = db.Sequelize;
  const stationIds = await guardStationIds(db, tenantId, userId);
  const or: any[] = [{ guardUserId: userId }];
  if (stationIds.length) or.push({ stationId: { [Op.in]: stationIds } });
  const entry = await db.radioCheckEntry.findOne({
    where: { tenantId, status: 'notified', deletedAt: null, [Op.or]: or },
    order: [['notifiedAt', 'DESC']],
  });
  if (!entry) return null;
  const session = await db.radioCheckSession.findOne({ where: { id: entry.sessionId, tenantId, status: 'running', deletedAt: null } });
  if (!session) return null;
  return entry;
}

/** Submit a guard's reply (voice clip, canned "Sin novedad", or free text). */
export async function submitReply(db: any, tenantId: string, entryId: string, guardUserId: string, payload: { audioUrl?: string; cannedText?: string; text?: string; clientMsgId?: string | null }): Promise<any> {
  const { Op } = db.Sequelize;
  const entry = await db.radioCheckEntry.findOne({ where: { id: entryId, tenantId, deletedAt: null } });
  if (!entry) { const e: any = new Error('Pase de novedades no encontrado'); e.code = 404; throw e; }

  // Idempotency: a retry with the same clientMsgId returns the stored entry.
  if (payload.clientMsgId && entry.clientMsgId && entry.clientMsgId === payload.clientMsgId) return entry;

  // Authorize: the replier must be the targeted guard OR assigned to the station.
  if (entry.guardUserId !== guardUserId) {
    const stationIds = await guardStationIds(db, tenantId, guardUserId);
    if (!stationIds.includes(entry.stationId)) { const e: any = new Error('No autorizado para este puesto'); e.code = 403; throw e; }
  }
  if (entry.status === 'responded') return entry; // first reply wins

  const isCanned = !!payload.cannedText || (!payload.audioUrl && !payload.text);
  const replyKind = payload.audioUrl ? 'voice' : payload.text ? 'text' : 'canned';
  const now = new Date();

  const next: any = {
    status: 'responded', respondedAt: now, guardUserId, replyKind,
    clientMsgId: payload.clientMsgId || entry.clientMsgId || null,
    updatedById: guardUserId,
  };
  if (replyKind === 'voice') {
    next.audioUrl = payload.audioUrl;
    next.transcriptStatus = 'pending';
    next.classification = 'unknown';
  } else if (replyKind === 'text') {
    next.transcript = String(payload.text).slice(0, 4000);
    next.transcriptStatus = 'done';
    next.classification = classifyText(next.transcript);
  } else {
    next.transcript = payload.cannedText || CANNED_SIN_NOVEDAD;
    next.transcriptStatus = 'skipped';
    next.classification = 'sin_novedad';
  }

  // Atomic claim: only the first reply (notified/pending → responded) wins.
  const [claimed] = await db.radioCheckEntry.update(next, {
    where: { id: entry.id, tenantId, status: { [Op.in]: ['notified', 'pending'] } },
  });
  if (!claimed) return db.radioCheckEntry.findOne({ where: { id: entry.id, tenantId } });

  const session = await db.radioCheckSession.findOne({ where: { id: entry.sessionId, tenantId } });
  if (session) await session.increment('respondedCount').catch(() => {});
  if (next.classification === 'incident' && session) await session.increment('incidentCount').catch(() => {});

  const fresh = await db.radioCheckEntry.findOne({ where: { id: entry.id, tenantId } });

  await storePlatformEvent(db, {
    tenantId, eventType: 'radio.reply', title: 'Respuesta de puesto', body: fresh.stationName || '',
    targetRoles: DISPATCHER_TARGET_ROLES, sourceEntityType: 'radioCheckEntry', sourceEntityId: fresh.id,
    payload: { sessionId: fresh.sessionId, entryId: fresh.id, stationId: fresh.stationId, stationName: fresh.stationName, classification: fresh.classification, replyKind, hasAudio: replyKind === 'voice' },
  }).catch(() => {});

  // Voice → transcribe + classify out of band (no-op without OPENAI_API_KEY).
  if (replyKind === 'voice') ai.transcribeEntry(db, tenantId, fresh.id).catch(() => {});

  // Advance the roll call now that this station answered.
  advanceSession(db, tenantId, fresh.sessionId).catch(() => {});
  return fresh;
}

// ---------------------------------------------------------------------------
// Read models (CRM)
// ---------------------------------------------------------------------------

/** Live console: every station + its on-duty guard + its latest entry status. */
export async function getConsole(db: any, tenantId: string): Promise<any> {
  const stations = await resolveStationsForCheck(db, tenantId, 'all');
  const running = await db.radioCheckSession.findOne({
    where: { tenantId, status: 'running', deletedAt: null }, order: [['startedAt', 'DESC']],
  });
  const rows: any[] = [];
  for (const { station, guards } of stations) {
    const latest = await db.radioCheckEntry.findOne({
      where: { tenantId, stationId: station.id, deletedAt: null },
      order: [['createdAt', 'DESC']],
    });
    rows.push({
      stationId: station.id, stationName: station.stationName,
      onDutyGuards: guards.map((g: any) => g.name),
      latest: latest ? {
        sessionId: latest.sessionId, entryId: latest.id, status: latest.status,
        classification: latest.classification, transcript: latest.transcript,
        transcriptStatus: latest.transcriptStatus, hasAudio: !!latest.audioUrl,
        respondedAt: latest.respondedAt, notifiedAt: latest.notifiedAt, guardName: latest.guardName,
      } : null,
    });
  }
  return { runningSessionId: running?.id || null, stations: rows };
}

export async function listSessions(db: any, tenantId: string, limit = 30): Promise<any[]> {
  return db.radioCheckSession.findAll({
    where: { tenantId, deletedAt: null }, order: [['startedAt', 'DESC']], limit: Math.min(limit, 100),
  });
}

export async function getSession(db: any, tenantId: string, sessionId: string): Promise<any | null> {
  const session = await db.radioCheckSession.findOne({ where: { id: sessionId, tenantId, deletedAt: null } });
  if (!session) return null;
  const entries = await db.radioCheckEntry.findAll({ where: { tenantId, sessionId, deletedAt: null }, order: [['seq', 'ASC']] });
  return { session, entries };
}
