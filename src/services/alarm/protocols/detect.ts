/**
 * Wire-format detector for inbound alarm receiver data.
 *
 * Looks at a raw Buffer (from TCP/UDP) and classifies it as one of:
 *   'dc09'      — SIA DC-09 IP frame (LF .. CR, quoted token, CRC+len)
 *   'contactid' — bare 16-digit Ademco Contact ID string
 *   'surgard'   — Sur-Gard automation line (receiver/line/account + Q+code)
 *   'unknown'   — none of the above
 *
 * Pure function. No DB.
 */

export type AlarmWireFormat = 'dc09' | 'contactid' | 'surgard' | 'unknown';

const LF = 0x0a;
const CR = 0x0d;

export function detectFormat(buf: Buffer): AlarmWireFormat {
  if (!buf || buf.length === 0) return 'unknown';

  const text = buf.toString('binary');

  // DC-09: framed by LF ... CR and contains a quoted token like "SIA-DCS",
  // "ADM-CID", "NULL" (optionally '*'-prefixed for AES). The strongest signal
  // is the leading LF + a quoted DC-09 token early in the frame.
  const hasFraming = buf[0] === LF || buf[buf.length - 1] === CR;
  if (hasFraming && /"\*?(SIA-DCS|ADM-CID|ACK|NAK|NULL|SIA-DC|CID)"/i.test(text)) {
    return 'dc09';
  }
  // Looser DC-09 detection: a quoted DC-09 token anywhere, even without strict
  // framing (some panels/transports strip the LF/CR).
  if (/"\*?(SIA-DCS|ADM-CID|NULL)"\d/.test(text)) {
    return 'dc09';
  }

  const trimmed = text.replace(/[\x02\x03\r\n]/g, '').trim();

  // Contact ID: exactly 16 hex digits, nothing else.
  if (/^[0-9A-Fa-f]{16}$/.test(trimmed)) {
    return 'contactid';
  }

  // Sur-Gard automation: whitespace-delimited tokens containing a Q+3-digit
  // (or bare 3-digit) event token, typically with receiver/line/account ahead.
  if (/\s/.test(trimmed) && /(^|\s)([A-Za-z]?\d{3})(\s|$)/.test(trimmed)) {
    return 'surgard';
  }

  return 'unknown';
}

export default { detectFormat };
