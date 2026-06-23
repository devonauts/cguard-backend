import { decrypt, last4 } from '../../lib/secretBox';

/**
 * Shape a radioDevice row for the API: drop the encrypted SIP password and expose
 * only whether it's set + its last 4 chars (mirrors how Stripe/Twilio secrets are
 * surfaced). NEVER return the raw/encrypted password.
 */
export function serializeRadioDevice(record: any): any {
  const p = record && typeof record.get === 'function' ? record.get({ plain: true }) : { ...record };
  const stored = p.sipPassword;
  delete p.sipPassword;
  const clear = decrypt(stored);
  p.sipPasswordConfigured = !!clear;
  p.sipPasswordLast4 = last4(clear);
  return p;
}
