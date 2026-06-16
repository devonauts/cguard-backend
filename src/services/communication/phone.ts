/**
 * phone — E.164 normalization shared by the Meta WhatsApp provider and the
 * inbound-session tracker so a webhook sender and a send recipient compare equal
 * regardless of formatting. Kept tiny and dependency-free (mirrors the
 * smsService.normalize behavior: strip everything but a leading '+' and digits).
 */

/**
 * Normalize a phone to canonical `+<digits>` form. Optionally prefixes a
 * tenant default country code (e.g. '+593') for local numbers lacking one.
 * Returns null when there aren't enough digits to be a real number.
 */
export function normalizeToE164(
  raw: string | null | undefined,
  defaultCountryCode?: string | null,
): string | null {
  if (!raw) return null;
  let s = String(raw).trim();
  if (!s) return null;

  const hadPlus = s.startsWith('+') || s.startsWith('00');
  // Strip all non-digits (drop a leading 00 international prefix → treat as +).
  let digits = s.replace(/\D/g, '');
  if (s.startsWith('00')) digits = digits.replace(/^00/, '');
  if (!digits) return null;

  // Apply default country code only for clearly-local numbers (no +, no 00,
  // and a sane local length). Never override an already-international number.
  if (!hadPlus && defaultCountryCode) {
    const cc = String(defaultCountryCode).replace(/\D/g, '');
    if (cc) {
      // If the number already begins with the country code, don't double it.
      if (!digits.startsWith(cc)) {
        // Drop a single leading national-access 0 before prefixing.
        const local = digits.replace(/^0+/, '');
        digits = cc + local;
      }
    }
  }

  if (digits.length < 7) return null;
  return '+' + digits;
}

/** Graph API wants the recipient as digits only (country code, no '+'). */
export function toWhatsAppRecipient(
  raw: string | null | undefined,
  defaultCountryCode?: string | null,
): string | null {
  const e164 = normalizeToE164(raw, defaultCountryCode);
  return e164 ? e164.replace(/^\+/, '') : null;
}

export default { normalizeToE164, toWhatsAppRecipient };
