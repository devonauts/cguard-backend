import crypto from 'crypto';
import ApiResponseHandler from '../apiResponseHandler';
import Error400 from '../../errors/Error400';
import Error401 from '../../errors/Error401';
import { ingestSignal } from '../../services/alarm/normalizer';

// POST /tenant/:tenantId/alarm/ingest
// Webhook entry point for alarm signals (panels / integrations that POST JSON).
// Body: { accountNumber, format, eventCode, qualifier, zoneNumber, partition, raw, alarmPanelId? }
//
// SECURITY: if env ALARM_WEBHOOK_SECRET is set, the request MUST carry a valid
// HMAC-SHA256 of the raw request body in the X-Alarm-Signature header
// (hex digest, optionally prefixed with "sha256="). This authenticates the
// sender since this endpoint is reachable by external panels.
export default async (req, res) => {
  try {
    const db = req.database;
    const tenantId = req.currentTenant.id;
    const body = req.body || {};

    const secret = process.env.ALARM_WEBHOOK_SECRET;
    if (secret) {
      const headerSig = String(
        req.headers['x-alarm-signature'] || req.headers['X-Alarm-Signature'] || '',
      ).replace(/^sha256=/i, '').trim();

      // Prefer the exact raw body captured by body-parser's verify hook if present;
      // otherwise fall back to a canonical JSON serialization of the parsed body.
      const rawBody: string =
        (req as any).rawBody !== undefined && (req as any).rawBody !== null
          ? typeof (req as any).rawBody === 'string'
            ? (req as any).rawBody
            : (req as any).rawBody.toString('utf8')
          : JSON.stringify(body);

      const expected = crypto
        .createHmac('sha256', secret)
        .update(rawBody, 'utf8')
        .digest('hex');

      const a = Buffer.from(headerSig, 'utf8');
      const b = Buffer.from(expected, 'utf8');
      const valid =
        headerSig.length > 0 &&
        a.length === b.length &&
        crypto.timingSafeEqual(a, b);

      if (!valid) {
        throw new Error401();
      }
    }

    if (!body.accountNumber && !body.alarmPanelId) {
      throw new Error400(req.language, 'errors.validation.missingFields');
    }

    const sig = {
      alarmPanelId: body.alarmPanelId || undefined,
      accountNumber: body.accountNumber,
      zoneNumber: body.zoneNumber,
      partition: body.partition,
      format: body.format || 'webhook',
      eventCode: body.eventCode,
      qualifier: body.qualifier,
      raw: body.raw,
      channel: body.channel || 'ip',
      receiverId: body.receiverId,
    };

    const result = await ingestSignal(db, tenantId, sig);

    await ApiResponseHandler.success(req, res, result);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
