import ApiResponseHandler from '../apiResponseHandler';

export default async (req, res, next) => {
  try {
    const payload = req.body?.data || req.body || {};

    // Minimal server-side handling: write to server logs.
    // Payload may include { level, message, details, path }
    try {
      const level = (payload.level || 'error').toLowerCase();
      const msg = payload.message || payload.msg || JSON.stringify(payload);
      if (level === 'warn' || level === 'warning') console.warn('[client-log]', msg, payload.details || '');
      else if (level === 'info') console.info('[client-log]', msg, payload.details || '');
      else console.error('[client-log]', msg, payload.details || '');
    } catch (e) {
      console.error('Error writing client log', e);
    }

    await ApiResponseHandler.success(req, res, { ok: true });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
