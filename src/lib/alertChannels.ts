/**
 * Off-panel alert delivery. The alertEvaluator already fires an in-app superadmin
 * notification per breach; this ALSO pushes it to channels a human sees when
 * they are NOT looking at the panel — the difference between "we noticed at 3am"
 * and "we noticed at 9am from a customer". All channels are env-gated and
 * best-effort, so a misconfigured channel never blocks the others.
 *
 *   ALERT_EMAIL_TO      comma-separated recipients (uses the existing mail layer)
 *   ALERT_SLACK_WEBHOOK Slack/Mattermost incoming-webhook URL
 *   ALERT_SMS_TO        comma-separated E.164 numbers (via the comms/SMS layer)
 */
export async function sendOffPanelAlert(alert: { key: string; title: string; body: string; metrics?: any }): Promise<void> {
  await Promise.allSettled([emailAlert(alert), slackAlert(alert), smsAlert(alert)]);
}

async function emailAlert(alert: { title: string; body: string }): Promise<void> {
  const to = (process.env.ALERT_EMAIL_TO || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!to.length) return;
  try {
    const { enqueueMail } = require('../services/mailService');
    const html = `<div style="font-family:system-ui,sans-serif"><h2 style="margin:0 0 8px">${escapeHtml(alert.title)}</h2>`
      + `<p style="color:#334155">${escapeHtml(alert.body)}</p>`
      + `<p style="color:#94a3b8;font-size:12px">CGuardPro · alerta automática · ${new Date().toISOString()}</p></div>`;
    await enqueueMail({ to, subject: `[CGuardPro] ${alert.title}`, html, text: alert.body });
  } catch (e: any) {
    console.error('[alert:email]', e?.message || e);
  }
}

async function slackAlert(alert: { title: string; body: string }): Promise<void> {
  const url = process.env.ALERT_SLACK_WEBHOOK;
  if (!url) return;
  try {
    if (typeof (globalThis as any).fetch !== 'function') return;
    await (globalThis as any).fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: `:rotating_light: *${alert.title}*\n${alert.body}` }),
    });
  } catch (e: any) {
    console.error('[alert:slack]', e?.message || e);
  }
}

async function smsAlert(alert: { title: string; body: string }): Promise<void> {
  const to = (process.env.ALERT_SMS_TO || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!to.length) return;
  try {
    // These are PLATFORM ops alerts (superadmin), so they go out through the
    // platform Twilio number (twilio/twilioClient — the superadmin phone
    // center), NOT a tenant subaccount and never a tenant wallet. Best-effort:
    // if the module/config isn't present we simply skip SMS.
    const twilioClient = tryRequire('../services/twilio/twilioClient');
    const send = twilioClient?.sendSms || twilioClient?.default?.sendSms;
    if (typeof send !== 'function') return;
    const { databaseInit } = require('../database/databaseConnection');
    const db = await databaseInit();
    const text = `[CGuardPro] ${alert.title}: ${alert.body}`.slice(0, 300);
    for (const n of to) { try { await send(db, { to: n, body: text }); } catch { /* per-number best-effort */ } }
  } catch (e: any) {
    console.error('[alert:sms]', e?.message || e);
  }
}

function tryRequire(p: string): any { try { return require(p); } catch { return null; } }
function escapeHtml(s: string): string {
  return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}
