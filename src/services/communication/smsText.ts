/**
 * smsText — central SMS body sanitizer + GSM-7 segment calculator.
 *
 * Every tenant-billed Twilio send MUST pass through toSmsBody() so that:
 *   1. emojis/pictographs (every notificationTemplates title starts with one)
 *      never silently force UCS-2 encoding (70/67 chars per segment instead of
 *      160/153 — a 3x-4x cost multiplier billed to the PLATFORM);
 *   2. Spanish accents that are NOT in the GSM-7 alphabet (á í ó ú Á Í Ó Ú) are
 *      folded to their plain vowels, while the accents that ARE GSM-7
 *      (é ñ ü ¿ ¡ à è ì ò ù) are kept — readable Spanish at 1-septet cost;
 *   3. typographic punctuation (— – · … smart quotes, NBSP) is transliterated
 *      instead of tripping UCS-2;
 *   4. the text is truncated at a word boundary to a septet budget (default 155
 *      → one segment), and the exact segment count is returned so callers can
 *      bill per segment (Twilio bills the platform per segment, not per message).
 *
 * Pure + dependency-free so the router, the providers and the legacy
 * smsService can all recompute it and agree on the result.
 */

/** GSM 03.38 basic character set — 1 septet each. */
const GSM_BASIC =
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?' +
  '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑܧ¿abcdefghijklmnopqrstuvwxyzäöñüà';

/** GSM 03.38 extension table — 2 septets each (ESC + char). */
const GSM_EXTENDED = '\f^{}\\[~]|€';

const BASIC_SET = new Set(GSM_BASIC.split(''));
const EXTENDED_SET = new Set(GSM_EXTENDED.split(''));

/**
 * Emoji / pictographs / flags / keycaps / skin tones / variation selectors /
 * ZWJ / tag characters — anything that exists only to decorate and forces the
 * whole message into UCS-2.
 */
const EMOJI_RE =
  /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{1F3FB}-\u{1F3FF}\u{FE0E}\u{FE0F}\u{200D}\u{20E3}\u{E0020}-\u{E007F}]/gu;

/** Non-GSM accents folded to plain vowels (é ñ ü ¿ ¡ are GSM — kept as-is). */
const FOLD_MAP: Record<string, string> = {
  á: 'a', í: 'i', ó: 'o', ú: 'u',
  Á: 'A', Í: 'I', Ó: 'O', Ú: 'U',
};

/**
 * Count GSM-7 septets for a text. Extended-table chars (^ { } \ [ ~ ] | €)
 * cost 2 septets. Non-GSM characters are counted as 1 here — but note they
 * would force UCS-2 on the wire; use toSmsBody() for the authoritative
 * segment count.
 */
export function gsmSeptets(text: string): number {
  let septets = 0;
  for (const ch of String(text || '')) {
    septets += EXTENDED_SET.has(ch) ? 2 : 1;
  }
  return septets;
}

/** Cost of one char in the current encoding (septets, or UTF-16 units for UCS-2). */
function charCost(ch: string, ucs2: boolean): number {
  if (ucs2) return ch.length; // UTF-16 code units (surrogate pairs cost 2)
  return EXTENDED_SET.has(ch) ? 2 : 1;
}

function isGsmChar(ch: string): boolean {
  return BASIC_SET.has(ch) || EXTENDED_SET.has(ch);
}

/** Total encoded size of a text in its natural encoding. */
function measure(text: string): { units: number; ucs2: boolean } {
  let ucs2 = false;
  for (const ch of text) {
    if (!isGsmChar(ch)) {
      ucs2 = true;
      break;
    }
  }
  if (ucs2) return { units: text.length, ucs2: true }; // UCS-2: UTF-16 code units
  return { units: gsmSeptets(text), ucs2: false };
}

/** Segments per the SMS concatenation rules (160/153 GSM-7, 70/67 UCS-2). */
function segmentCount(units: number, ucs2: boolean): number {
  if (units <= 0) return 0;
  if (ucs2) return units <= 70 ? 1 : Math.ceil(units / 67);
  return units <= 160 ? 1 : Math.ceil(units / 153);
}

/** Strip emoji, transliterate typography, fold non-GSM accents, collapse spaces. */
function sanitize(raw: string | undefined | null): string {
  let s = String(raw ?? '');
  if (!s) return '';

  // 1) Emoji / pictographs / variation selectors / ZWJ / flags / keycaps.
  s = s.replace(EMOJI_RE, '');

  // 2) Typographic punctuation → GSM-safe equivalents.
  s = s
    .replace(/[—–]/g, '-') // em/en dash
    .replace(/·/g, '-') // middle dot separator
    .replace(/[‘’‚‛`´]/g, "'") // smart single quotes
    .replace(/[“”„‟«»]/g, '"') // smart double quotes
    .replace(/…/g, '...') // ellipsis
    .replace(/[\u00A0\u2000-\u200B\u202F\u205F\u3000\uFEFF]/g, ' '); // NBSP + unicode spaces

  // 3) Fold ONLY the non-GSM Spanish accents (keep é ñ ü ¿ ¡ à è ì ò ù).
  s = s.replace(/[áíóúÁÍÓÚ]/g, (ch) => FOLD_MAP[ch] || ch);

  // 4) Collapse all whitespace (titles+bodies join on one line anyway).
  s = s.replace(/\s+/g, ' ').trim();

  return s;
}

export interface SmsBodyResult {
  /** The sanitized, truncated text to hand to Twilio. */
  text: string;
  /** Billable SMS segments for this text (0 for empty text). */
  segments: number;
  /** True when user content still carries non-GSM chars (billed at 70/67). */
  ucs2: boolean;
}

/**
 * Build the final SMS body from a title + body.
 *
 *   toSmsBody('🚨 Pánico', 'Botón activado — Estación Norte')
 *     → { text: 'Panico: Boton activado - Estacion Norte', segments: 1, ucs2: false }
 *
 * opts.maxChars is a SEPTET budget (UTF-16 units when the text ends up UCS-2),
 * default 155 → the platform default is "everything fits in one GSM segment".
 * Truncation happens at a word boundary and appends '...'.
 */
export function toSmsBody(
  title: string | undefined,
  body: string | undefined,
  opts: { maxChars?: number } = {},
): SmsBodyResult {
  const maxChars = opts.maxChars && opts.maxChars > 0 ? opts.maxChars : 155;

  const t = sanitize(title);
  const b = sanitize(body);
  let text = t && b ? `${t}: ${b}` : t || b;

  if (!text) return { text: '', segments: 0, ucs2: false };

  let { units, ucs2 } = measure(text);

  // Truncate at a word boundary within the budget, appending '...' (3 units).
  if (units > maxChars) {
    const budget = Math.max(1, maxChars - 3);
    const chars = Array.from(text);
    let acc = 0;
    let cut = 0;
    let lastSpace = -1;
    for (let i = 0; i < chars.length; i += 1) {
      const c = charCost(chars[i], ucs2);
      if (acc + c > budget) break;
      acc += c;
      cut = i + 1;
      if (chars[i] === ' ') lastSpace = i;
    }
    const at = lastSpace > 0 ? lastSpace : cut;
    text = chars.slice(0, at).join('').replace(/[\s.,;:!?-]+$/, '') + '...';
    ({ units, ucs2 } = measure(text));
  }

  return { text, segments: segmentCount(units, ucs2), ucs2 };
}

export default { toSmsBody, gsmSeptets };
