/**
 * OpenAI-backed transcription + roll-call summary for the radio check.
 *
 * Graceful degradation is mandatory (mirrors pushService): with no OPENAI_API_KEY
 * every function is a safe no-op — the audio clip is already stored, the entry
 * stays transcriptStatus='pending', and the session summary is marked 'skipped'.
 * All calls are invoked fire-and-forget off the request path, so a slow/missing
 * OpenAI never blocks a guard's reply or the dispatcher.
 *
 * No ffmpeg on the server → we only ever send OpenAI-native containers (m4a/aac
 * from the native recorder, webm/opus from the web fallback, wav). No transcoding.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import FileStorage from './file/fileStorage';
import { storePlatformEvent } from '../lib/platformEventStore';
import { broadcastPcm } from '../lib/radioVoice';
import { classifyText } from './radio/classify';

const KEY = process.env.OPENAI_API_KEY || '';
const TRANSCRIBE_MODEL = process.env.OPENAI_TRANSCRIBE_MODEL || 'gpt-4o-transcribe';
const SUMMARY_MODEL = process.env.OPENAI_SUMMARY_MODEL || 'gpt-4o-mini';
// Text-to-speech: the AI "dispatcher" voice that conducts the pase de novedades.
const TTS_MODEL = process.env.OPENAI_TTS_MODEL || 'gpt-4o-mini-tts';
// Female dispatcher voice by default ('nova' is a clear female voice). Override
// with OPENAI_TTS_VOICE (e.g. shimmer/coral/sage are also female; alloy neutral).
const TTS_VOICE = process.env.OPENAI_TTS_VOICE || 'nova';
const DISPATCHER_TARGET_ROLES = 'admin,operationsManager,securitySupervisor,dispatcher';
// Timezone used to pick the spoken greeting (server runs UTC; tenants are local).
const RADIO_TZ = process.env.RADIO_TZ || 'America/Guayaquil';

export function isEnabled(): boolean { return !!KEY; }

/** The spoken line the AI dispatcher uses to call a station for its report. */
export function buildStationPromptText(stationName?: string | null): string {
  const name = (stationName || 'puesto').trim();
  return `${name}, aquí central de monitoreo. Adelante con su pase de novedades. Reporte cualquier novedad o indique sin novedad. Cambio.`;
}

/** Time-of-day greeting (días/tardes/noches) in the tenant's timezone. */
function greeting(): string {
  let hour = new Date().getHours();
  try {
    const h = new Intl.DateTimeFormat('en-US', { timeZone: RADIO_TZ, hour: 'numeric', hour12: false }).format(new Date());
    const n = parseInt(h, 10);
    if (Number.isFinite(n)) hour = n % 24;
  } catch { /* fall back to server hour */ }
  if (hour < 12) return 'Buenos días';
  if (hour < 19) return 'Buenas tardes';
  return 'Buenas noches';
}

/**
 * The single OPENING announcement the AI specialist speaks to ALL guards when a
 * pase de novedades starts. They then have one minute to complete their report.
 */
export function buildOpeningAnnouncement(): string {
  return `${greeting()} compañeros, saludos desde la central. Por favor revisen sus dispositivos y completen el reporte de novedades. Tienen un minuto para completarlo. Si no se completa dentro del minuto, se marcará su reporte como fallido.`;
}

/** Speak the opening announcement live into the open radio channel (best-effort). */
export async function broadcastOpening(tenantId: string): Promise<void> {
  try {
    const pcm = await synthesizeSpeechPcm(buildOpeningAnnouncement());
    if (pcm) await broadcastPcm(tenantId, pcm, OPENAI_PCM_RATE, 'Central de monitoreo');
  } catch (e: any) {
    console.warn('[radioCheck] opening broadcast failed:', e?.message || e);
  }
}

/**
 * Synthesize `text` to speech with OpenAI TTS, store the MP3 under `privateUrl`,
 * and return a playable download URL (token-based). Safe no-op (returns null)
 * when no key / on any error — the pase still proceeds with the text prompt.
 */
export async function synthesizeSpeech(privateUrl: string, text: string): Promise<string | null> {
  if (!KEY || !text || !text.trim()) return null;
  let tmp = '';
  try {
    const res = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: TTS_MODEL, voice: TTS_VOICE, input: text.slice(0, 4000), response_format: 'mp3' }),
    });
    if (!res.ok) throw new Error(`OpenAI TTS ${res.status}: ${await res.text()}`);
    const buf = Buffer.from(await res.arrayBuffer());
    tmp = path.join(os.tmpdir(), `tts-${Date.now()}-${Math.round(Math.random() * 1e9)}.mp3`);
    fs.writeFileSync(tmp, buf);
    const downloadUrl = await FileStorage.upload(tmp, privateUrl);
    return downloadUrl;
  } catch (e: any) {
    console.warn('[radioCheck] TTS failed:', e?.message || e);
    return null;
  } finally {
    if (tmp) { try { fs.unlinkSync(tmp); } catch { /* ignore */ } }
  }
}

/**
 * Synthesize `text` to RAW PCM (16-bit signed LE mono @ 24 kHz — OpenAI's `pcm`
 * format) for injection into the live radio channel. Returned as Int16Array.
 * No ffmpeg involved (we ask OpenAI for PCM directly). null on no-key/error.
 */
export async function synthesizeSpeechPcm(text: string): Promise<Int16Array | null> {
  if (!KEY || !text || !text.trim()) return null;
  try {
    const res = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: TTS_MODEL, voice: TTS_VOICE, input: text.slice(0, 4000), response_format: 'pcm' }),
    });
    if (!res.ok) throw new Error(`OpenAI TTS pcm ${res.status}: ${await res.text()}`);
    const ab = await res.arrayBuffer();
    // OpenAI pcm = 24 kHz, 16-bit signed little-endian, mono. Host is LE.
    return new Int16Array(ab.slice(0, ab.byteLength - (ab.byteLength % 2)));
  } catch (e: any) {
    console.warn('[radioCheck] TTS pcm failed:', e?.message || e);
    return null;
  }
}

/** Sample rate OpenAI returns for `response_format: 'pcm'`. */
export const OPENAI_PCM_RATE = 24000;

/** Read a stored clip provider-agnostically (localhost path or remote URL). */
async function readAudio(privateUrl: string): Promise<{ buf: Buffer; filename: string }> {
  const filename = (privateUrl.split('/').pop() || 'audio').split('?')[0] || 'audio.m4a';
  const ref: any = await FileStorage.download(privateUrl);
  if (typeof ref === 'string' && /^https?:\/\//i.test(ref)) {
    const r = await fetch(ref);
    if (!r.ok) throw new Error(`fetch audio ${r.status}`);
    return { buf: Buffer.from(await r.arrayBuffer()), filename };
  }
  // localhost provider returns a filesystem path
  return { buf: fs.readFileSync(ref), filename };
}

/** Transcribe a voice reply, classify it, persist, and nudge the CRM live. */
export async function transcribeEntry(db: any, tenantId: string, entryId: string): Promise<void> {
  if (!KEY) return; // leave transcriptStatus='pending'
  const entry = await db.radioCheckEntry.findOne({ where: { id: entryId, tenantId } });
  if (!entry || !entry.audioUrl) return;
  try {
    const { buf, filename } = await readAudio(entry.audioUrl);
    const form = new FormData();
    form.append('file', new Blob([buf]), filename);
    form.append('model', TRANSCRIBE_MODEL);
    form.append('language', 'es');
    const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST', headers: { Authorization: `Bearer ${KEY}` }, body: form as any,
    });
    if (!res.ok) throw new Error(`OpenAI transcribe ${res.status}: ${await res.text()}`);
    const data: any = await res.json();
    const transcript = String(data.text || '').trim();
    const classification = classifyText(transcript);
    await db.radioCheckEntry.update({ transcript, transcriptStatus: 'done', classification }, { where: { id: entryId, tenantId } });
    if (classification === 'incident') {
      await db.radioCheckSession.increment('incidentCount', { where: { id: entry.sessionId, tenantId } }).catch(() => {});
    }
    await storePlatformEvent(db, {
      tenantId, eventType: 'radio.reply', title: 'Transcripción lista', body: entry.stationName || '',
      targetRoles: DISPATCHER_TARGET_ROLES, sourceEntityType: 'radioCheckEntry', sourceEntityId: entryId,
      payload: { sessionId: entry.sessionId, entryId, stationId: entry.stationId, stationName: entry.stationName, classification, transcript, transcriptStatus: 'done', hasAudio: true },
    }).catch(() => {});
  } catch (e: any) {
    console.warn('[radioCheck] transcribe failed:', e?.message || e);
    await db.radioCheckEntry.update({ transcriptStatus: 'failed' }, { where: { id: entryId, tenantId } }).catch(() => {});
  }
}

const statusLabel = (s: string) =>
  ({ responded: 'respondió', no_response: 'SIN RESPUESTA', skipped: 'sin guardia en turno', pending: 'pendiente', notified: 'llamado' } as any)[s] || s;

/**
 * Deterministic Spanish roll-call summary built straight from the entries — no
 * AI needed. Used when OpenAI is unavailable (no key, quota exhausted, outage),
 * so a pase de novedades ALWAYS produces a usable report instead of a blank /
 * "failed" state. Returns a concise, structured summary.
 */
function buildBasicSummary(entries: any[]): string {
  const total = entries.length;
  const responded = entries.filter((e) => e.status === 'responded').length;
  const incidents = entries.filter((e) => e.classification === 'incident');
  const novedades = entries.filter((e) => e.classification === 'novedad' && e.transcript);
  const noResp = entries.filter((e) => e.status === 'no_response');

  const parts: string[] = [`Pase de novedades: ${responded} de ${total} puesto(s) respondieron.`];
  if (incidents.length) {
    parts.push(
      `\n⚠️ INCIDENTES (${incidents.length}):\n` +
        incidents.map((e) => `- ${e.stationName || 'Puesto'}: "${(e.transcript || '').trim() || 'reporte de incidente'}"`).join('\n'),
    );
  }
  if (novedades.length) {
    parts.push(
      `\nNovedades:\n` +
        novedades.map((e) => `- ${e.stationName || 'Puesto'}: "${(e.transcript || '').trim()}"`).join('\n'),
    );
  }
  if (noResp.length) {
    parts.push(`\nSIN RESPUESTA (${noResp.length}): ` + noResp.map((e) => e.stationName || 'Puesto').join(', '));
  }
  return parts.join('\n');
}

/** Generate a Spanish roll-call summary for a completed session. */
export async function generateSummary(db: any, tenantId: string, sessionId: string): Promise<void> {
  const entries = await db.radioCheckEntry.findAll({ where: { tenantId, sessionId, deletedAt: null }, order: [['seq', 'ASC']] });
  if (!entries.length) { await db.radioCheckSession.update({ summaryStatus: 'skipped' }, { where: { id: sessionId, tenantId } }).catch(() => {}); return; }

  // Always have a usable summary ready; AI replaces it on success.
  const fallback = buildBasicSummary(entries);
  const finish = async (summary: string) => {
    // Voice the closing report (the AI dispatcher "reads out" the pase result).
    const spoken =
      'Pase de novedades completado. ' +
      summary.replace(/[⚠️*#_`>-]/g, ' ').replace(/\s*\n+\s*/g, '. ').replace(/\s{2,}/g, ' ').trim();
    const summaryAudioUrl = await synthesizeSpeech(`radio-check/${tenantId}/${sessionId}/summary.mp3`, spoken);
    await db.radioCheckSession
      .update({ summary, summaryStatus: 'done', ...(summaryAudioUrl ? { summaryAudioUrl } : {}) }, { where: { id: sessionId, tenantId } })
      .catch(() => {});
    await storePlatformEvent(db, {
      tenantId, eventType: 'radio.session_completed', title: 'Resumen del pase listo', body: '',
      targetRoles: DISPATCHER_TARGET_ROLES, sourceEntityType: 'radioCheckSession', sourceEntityId: sessionId,
      payload: { sessionId, summaryReady: true, summaryAudioUrl: summaryAudioUrl || null },
    }).catch(() => {});
    // Read the closing report over the live radio channel (fire-and-forget).
    void (async () => {
      try {
        const pcm = await synthesizeSpeechPcm(spoken);
        if (pcm) await broadcastPcm(tenantId, pcm, OPENAI_PCM_RATE, 'Central de monitoreo');
      } catch { /* ignore */ }
    })();
  };

  if (!KEY) { await finish(fallback); return; } // no AI configured → deterministic summary

  const lines = entries.map((e: any) => `- ${e.stationName || 'Puesto'}: ${statusLabel(e.status)}${e.transcript ? ` — "${e.transcript}"` : ''}`).join('\n');
  const prompt = `Eres el operador de central de una empresa de seguridad privada. Resume este pase de novedades en español, breve y profesional (3-6 líneas): di cuántos puestos respondieron de cuántos, resalta cualquier NOVEDAD o INCIDENTE textualmente, y enumera al final los puestos SIN RESPUESTA. No inventes datos.\n\nPase de novedades:\n${lines}`;
  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: SUMMARY_MODEL, messages: [{ role: 'user', content: prompt }], temperature: 0.2, max_tokens: 500 }),
    });
    if (!res.ok) throw new Error(`OpenAI summary ${res.status}: ${await res.text()}`);
    const data: any = await res.json();
    const summary = String(data.choices?.[0]?.message?.content || '').trim();
    await finish(summary || fallback);
  } catch (e: any) {
    // Quota/outage/etc — never leave the dispatcher without a report.
    console.warn('[radioCheck] summary AI failed, using basic summary:', e?.message || e);
    await finish(fallback);
  }
}
