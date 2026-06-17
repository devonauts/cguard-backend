/**
 * Platform Twilio voice-call persistence + realtime fan-out (SuperAdmin phone
 * center). Maps voice webhooks / outbound calls onto twilioCall rows and emits
 * live updates to all superadmin browsers via emitSuperadminEvent.
 * Platform-scoped (no tenant filter).
 *
 * Socket events emitted (EXACT names — frontend listens for these):
 *   'twilio:call:incoming' { callSid, from }
 *   'twilio:call:status'   { callSid, status, durationSec? }
 */
import { emitSuperadminEvent } from '../../lib/realtime';

function serializeCall(c: any) {
  if (!c) return null;
  return {
    id: c.id,
    callSid: c.callSid,
    direction: c.direction,
    fromNumber: c.fromNumber,
    toNumber: c.toNumber,
    status: c.status,
    durationSec: c.durationSec,
    startedAt: c.startedAt,
    endedAt: c.endedAt,
    recordingUrl: c.recordingUrl,
    createdAt: c.createdAt,
  };
}

export interface RecordCallArgs {
  callSid: string;
  direction: 'inbound' | 'outbound';
  from?: string;
  to?: string;
  status?: string;
}

/**
 * Upsert a call by SID (so a webhook that fires before/after we already have a
 * row is idempotent). Emits 'twilio:call:incoming' for new inbound calls.
 */
export async function recordCall(database: any, args: RecordCallArgs) {
  const [call, created] = await database.twilioCall.findOrCreate({
    where: { callSid: args.callSid },
    defaults: {
      callSid: args.callSid,
      direction: args.direction,
      fromNumber: args.from || null,
      toNumber: args.to || null,
      status: args.status || null,
      startedAt: new Date(),
    },
  });
  if (!created) {
    const patch: any = {};
    if (args.status) patch.status = args.status;
    if (args.from && !call.fromNumber) patch.fromNumber = args.from;
    if (args.to && !call.toNumber) patch.toNumber = args.to;
    if (Object.keys(patch).length) await call.update(patch);
  }

  if (created && args.direction === 'inbound') {
    emitSuperadminEvent('twilio:call:incoming', { callSid: args.callSid, from: args.from || null });
  }
  return serializeCall(call);
}

/**
 * Patch a call (status / duration / timestamps / recording) by SID and emit
 * 'twilio:call:status'. Creates a minimal row if the SID isn't known yet.
 */
export async function updateCall(
  database: any,
  callSid: string,
  fields: {
    status?: string;
    durationSec?: number | null;
    startedAt?: Date | null;
    endedAt?: Date | null;
    recordingUrl?: string | null;
    from?: string;
    to?: string;
    direction?: 'inbound' | 'outbound';
  },
) {
  let call = await database.twilioCall.findOne({ where: { callSid } });
  if (!call) {
    call = await database.twilioCall.create({
      callSid,
      direction: fields.direction || 'inbound',
      fromNumber: fields.from || null,
      toNumber: fields.to || null,
      status: fields.status || null,
    });
  }
  const patch: any = {};
  if (fields.status !== undefined) patch.status = fields.status;
  if (fields.durationSec !== undefined) patch.durationSec = fields.durationSec;
  if (fields.startedAt !== undefined) patch.startedAt = fields.startedAt;
  if (fields.endedAt !== undefined) patch.endedAt = fields.endedAt;
  if (fields.recordingUrl !== undefined) patch.recordingUrl = fields.recordingUrl;
  if (fields.from && !call.fromNumber) patch.fromNumber = fields.from;
  if (fields.to && !call.toNumber) patch.toNumber = fields.to;
  if (Object.keys(patch).length) await call.update(patch);

  emitSuperadminEvent('twilio:call:status', {
    callSid,
    status: patch.status ?? call.status,
    durationSec: patch.durationSec ?? call.durationSec ?? undefined,
  });
  return serializeCall(call);
}

/** Paginated call log, most-recent first. */
export async function listCalls(database: any, opts: { page?: number; limit?: number } = {}) {
  const page = Math.max(1, opts.page || 1);
  const limit = Math.min(200, Math.max(1, opts.limit || 50));
  const { rows, count } = await database.twilioCall.findAndCountAll({
    order: [['createdAt', 'DESC']],
    limit,
    offset: (page - 1) * limit,
  });
  return { rows: rows.map(serializeCall), count, page, limit };
}

export default { recordCall, updateCall, listCalls };
