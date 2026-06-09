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
import FileStorage from './file/fileStorage';
import { storePlatformEvent } from '../lib/platformEventStore';
import { classifyText } from './radio/classify';

const KEY = process.env.OPENAI_API_KEY || '';
const TRANSCRIBE_MODEL = process.env.OPENAI_TRANSCRIBE_MODEL || 'gpt-4o-transcribe';
const SUMMARY_MODEL = process.env.OPENAI_SUMMARY_MODEL || 'gpt-4o-mini';
const DISPATCHER_TARGET_ROLES = 'admin,operationsManager,securitySupervisor,dispatcher';

export function isEnabled(): boolean { return !!KEY; }

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

/** Generate a Spanish roll-call summary for a completed session. */
export async function generateSummary(db: any, tenantId: string, sessionId: string): Promise<void> {
  if (!KEY) { await db.radioCheckSession.update({ summaryStatus: 'skipped' }, { where: { id: sessionId, tenantId } }).catch(() => {}); return; }
  const entries = await db.radioCheckEntry.findAll({ where: { tenantId, sessionId, deletedAt: null }, order: [['seq', 'ASC']] });
  if (!entries.length) { await db.radioCheckSession.update({ summaryStatus: 'skipped' }, { where: { id: sessionId, tenantId } }).catch(() => {}); return; }
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
    await db.radioCheckSession.update({ summary, summaryStatus: 'done' }, { where: { id: sessionId, tenantId } });
    await storePlatformEvent(db, {
      tenantId, eventType: 'radio.session_completed', title: 'Resumen del pase listo', body: '',
      targetRoles: DISPATCHER_TARGET_ROLES, sourceEntityType: 'radioCheckSession', sourceEntityId: sessionId,
      payload: { sessionId, summaryReady: true },
    }).catch(() => {});
  } catch (e: any) {
    console.warn('[radioCheck] summary failed:', e?.message || e);
    await db.radioCheckSession.update({ summaryStatus: 'failed' }, { where: { id: sessionId, tenantId } }).catch(() => {});
  }
}
