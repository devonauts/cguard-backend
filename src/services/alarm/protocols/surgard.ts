/**
 * Sur-Gard MLR2-DG / SG-System automation-output line parser.
 *
 * When a HARDWARE receiver (Sur-Gard / DSC) terminates the call/IP session
 * from the panel, it forwards a normalized line to the automation software
 * over its serial/TCP automation port. The common Sur-Gard automation format
 * (a.k.a. the "MLR2 / SG-System II/III automation protocol") looks like:
 *
 *   <RRR><LL> <SSSS> <Q><EEE> <GG> <CCC>
 *
 * e.g.   "5061 18 1234 E130 01 005"
 *
 *   RRR  receiver number (often 1-4 digits)
 *   LL   line/port number on the receiver
 *   SSSS account number (3-4+ hex digits)
 *   Q    qualifier letter: E = event/new, R = restore, S/P = status
 *   EEE  3-digit Contact ID event code (Sur-Gard re-emits CID numerics)
 *   GG   partition / group
 *   CCC  zone or user
 *
 * There are MANY framing variants across receiver firmwares (some wrap the
 * line in STX/ETX, some use the "SIA" 5-field form, some omit receiver/line).
 * This is a BEST-EFFORT parser.
 *
 * TODO: tune the exact field framing to the deployed Sur-Gard receiver model
 *       (MLR2-DG vs SG-System I/II/III/5) and its automation protocol setting
 *       (e.g. "Sur-Gard", "Radionics 6500", "Ademco 685"). Verify against a
 *       live receiver capture before production use.
 *
 * Pure function. No DB.
 */

export interface SurgardParsed {
  receiver: string;
  line: string;
  account: string;
  eventCode: string; // 3-digit CID code when present
  qualifier: string; // normalized: 'event' | 'restore' | 'status'
  zone: string;
  partition: string;
  raw: string;
}

/** Normalize a Sur-Gard qualifier letter to our qualifier vocabulary. */
function normalizeQualifier(q: string): string {
  switch ((q || '').toUpperCase()) {
    case 'E': // new event
    case 'O': // opening (treated as event-level)
      return 'event';
    case 'R': // restore / closing
      return 'restore';
    case 'S': // status
    case 'P': // previously reported / status
      return 'status';
    default:
      return 'event';
  }
}

/**
 * Parse a Sur-Gard automation line. Strips STX/ETX/CR/LF framing first.
 */
export function parseSurgard(line: string): SurgardParsed {
  const raw = line || '';
  // Strip common framing: STX(0x02) ETX(0x03) CR LF and surrounding whitespace.
  const cleaned = raw.replace(/[\x02\x03\r\n]/g, '').trim();

  const result: SurgardParsed = {
    receiver: '',
    line: '',
    account: '',
    eventCode: '',
    qualifier: 'event',
    zone: '',
    partition: '',
    raw,
  };

  // Tokenize on whitespace; Sur-Gard automation lines are space-delimited.
  const tokens = cleaned.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return result;

  // Find the event token of the form Q + 3 digits, e.g. "E130" or "R130".
  // Some firmwares omit the qualifier letter and send "130" directly.
  let eventIdx = -1;
  for (let i = 0; i < tokens.length; i++) {
    if (/^[A-Za-z]\d{3}$/.test(tokens[i]) || /^\d{3}$/.test(tokens[i])) {
      // Prefer a token that has a qualifier letter; fall back to bare 3-digit.
      if (/^[A-Za-z]\d{3}$/.test(tokens[i])) {
        eventIdx = i;
        break;
      }
      if (eventIdx < 0) eventIdx = i;
    }
  }

  if (eventIdx >= 0) {
    const tok = tokens[eventIdx];
    const m = tok.match(/^([A-Za-z])?(\d{3})$/);
    if (m) {
      if (m[1]) result.qualifier = normalizeQualifier(m[1]);
      result.eventCode = m[2];
    }

    // Heuristic field assignment around the event token.
    // Layout assumed: [receiver] [line] [account] <event> [partition] [zone]
    const before = tokens.slice(0, eventIdx);
    const after = tokens.slice(eventIdx + 1);

    if (before.length >= 3) {
      // receiver may be glued to line as "RRRLL"; keep as-is best-effort.
      result.receiver = before[before.length - 3];
      result.line = before[before.length - 2];
      result.account = before[before.length - 1];
    } else if (before.length === 2) {
      result.line = before[0];
      result.account = before[1];
    } else if (before.length === 1) {
      result.account = before[0];
    }

    if (after.length >= 2) {
      result.partition = after[0];
      result.zone = after[1];
    } else if (after.length === 1) {
      result.zone = after[0];
    }
  } else {
    // No recognizable event token; stash the whole cleaned line as account so
    // the caller can decide what to do.
    result.account = tokens[0] || '';
  }

  return result;
}

export default { parseSurgard };
