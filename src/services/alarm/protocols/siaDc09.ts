/**
 * SIA DC-09 (ANSI/SIA DC-09-2013) frame parser, ACK builder, CRC16 and
 * optional AES-128/256 payload decryption.
 *
 * A DC-09 frame on the wire looks like:
 *
 *   <LF> <CRC4> <LLLL> "token" seq Rrcvr Lpfx #acct [ data ] _timestamp <CR>
 *
 *   <LF>        0x0A start byte
 *   <CRC4>      4 ASCII hex chars: CRC-16 (ARC/IBM) over the frame body
 *               that follows the length field (the part starting at the
 *               leading double-quote of the token and ending just before the
 *               trailing <CR>).
 *   <LLLL>      4 ASCII hex chars: the length (in chars) of that same body.
 *   "token"     message id token in double quotes, e.g. "SIA-DCS",
 *               "ADM-CID" (Contact ID payload), "NULL" (link test).
 *               A leading '*' (i.e. "*SIA-DCS") marks an AES-encrypted body.
 *   seq         4-digit sequence number.
 *   Rrcvr       optional receiver number, prefixed 'R'.
 *   Lpfx        optional line/account prefix, prefixed 'L'.
 *   #acct       '#' + account number.
 *   [data]      message data in square brackets (SIA blocks or CID digits).
 *   _timestamp  optional '_HH:MM:SS,MM-DD-YYYY'.
 *   <CR>        0x0D end byte.
 *
 * References: ANSI/SIA DC-09-2013 "Internet Protocol Event Reporting".
 * Spec assumptions are marked with NOTE comments.
 *
 * Pure functions. No DB.
 */

import * as crypto from 'crypto';

export interface Dc09Parsed {
  crcOk: boolean;
  token: string; // e.g. 'SIA-DCS', 'ADM-CID', 'NULL' (without quotes / '*')
  encrypted: boolean; // true if token had a leading '*'
  seq: string;
  receiver: string; // value after 'R' (may be '')
  prefix: string; // value after 'L' (may be '')
  account: string; // value after '#'
  data: string; // contents of [...] (decrypted if a key is supplied to parse)
  timestamp: string; // contents after '_' (may be '')
  raw: string; // the full original frame as text
  length: number; // declared LLLL length
  lengthOk: boolean; // declared length matched the actual body length
}

const LF = 0x0a;
const CR = 0x0d;

/**
 * CRC-16/ARC (a.k.a. IBM/ANSI) as required by DC-09.
 * Polynomial 0xA001 (reflected 0x8005), init 0x0000.
 */
export function crc16(buf: Buffer | string): number {
  const data = typeof buf === 'string' ? Buffer.from(buf, 'binary') : buf;
  let crc = 0x0000;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i];
    for (let b = 0; b < 8; b++) {
      if (crc & 0x0001) {
        crc = (crc >>> 1) ^ 0xa001;
      } else {
        crc >>>= 1;
      }
    }
  }
  return crc & 0xffff;
}

/** CRC as the 4-char uppercase ASCII hex used in DC-09 frames. */
export function crc16Hex(buf: Buffer | string): string {
  return crc16(buf).toString(16).toUpperCase().padStart(4, '0');
}

/**
 * Extract the textual frame body (everything between the length field and the
 * trailing CR). Returns the body string plus the leading CRC/length tokens.
 *
 * We operate on a binary string so byte positions line up with the spec.
 */
function stripFrame(buf: Buffer): { crc: string; len: string; body: string; raw: string } | null {
  // Drop a single leading LF and a single trailing CR if present.
  let start = 0;
  let end = buf.length;
  if (end > 0 && buf[start] === LF) start++;
  if (end > start && buf[end - 1] === CR) end--;
  const inner = buf.slice(start, end).toString('binary');
  const raw = buf.toString('binary');

  // crc(4) + len(4) then the body.
  if (inner.length < 8) return null;
  const crc = inner.slice(0, 4);
  const len = inner.slice(4, 8);
  if (!/^[0-9A-Fa-f]{4}$/.test(crc) || !/^[0-9A-Fa-f]{4}$/.test(len)) {
    return null;
  }
  const body = inner.slice(8);
  return { crc, len, body, raw };
}

/**
 * Parse the body portion ("token"seq Rrcvr Lpfx #acct [data] _ts).
 */
function parseBody(body: string): Omit<Dc09Parsed, 'crcOk' | 'raw' | 'length' | 'lengthOk'> {
  let token = '';
  let encrypted = false;
  let seq = '';
  let receiver = '';
  let prefix = '';
  let account = '';
  let data = '';
  let timestamp = '';

  // Optional leading '*' => AES encrypted body.
  let rest = body;
  if (rest.startsWith('*')) {
    encrypted = true;
    rest = rest.slice(1);
  }

  // "token"
  const tokMatch = rest.match(/^"([^"]*)"/);
  if (tokMatch) {
    token = tokMatch[1];
    rest = rest.slice(tokMatch[0].length);
  }

  // seq: leading run of digits (typically 4).
  const seqMatch = rest.match(/^(\d{1,4})/);
  if (seqMatch) {
    seq = seqMatch[1];
    rest = rest.slice(seqMatch[0].length);
  }

  // R receiver (optional)
  const rMatch = rest.match(/^R([0-9A-Fa-f]+)/);
  if (rMatch) {
    receiver = rMatch[1];
    rest = rest.slice(rMatch[0].length);
  }

  // L prefix / line (optional)
  const lMatch = rest.match(/^L([0-9A-Fa-f]+)/);
  if (lMatch) {
    prefix = lMatch[1];
    rest = rest.slice(lMatch[0].length);
  }

  // #account
  const acctMatch = rest.match(/^#([0-9A-Fa-f]+)/);
  if (acctMatch) {
    account = acctMatch[1];
    rest = rest.slice(acctMatch[0].length);
  }

  // [data]  (the body of the message; for ADM-CID it is the CID digits)
  const dataMatch = rest.match(/\[([^\]]*)\]/);
  if (dataMatch) {
    data = dataMatch[1];
    rest = rest.slice((dataMatch.index || 0) + dataMatch[0].length);
  }

  // _timestamp (optional, runs to end)
  const tsMatch = rest.match(/_([^\r\n]*)$/);
  if (tsMatch) {
    timestamp = tsMatch[1];
  }

  return { token, encrypted, seq, receiver, prefix, account, data, timestamp };
}

/**
 * Parse a DC-09 frame.
 *
 * @param buf  raw bytes from the socket.
 * @param keyHex optional AES key (hex) used to decrypt an encrypted [data]
 *               block. If decryption is requested and succeeds, `data` holds
 *               the plaintext; `encrypted` still reflects the wire format.
 */
export function parseDc09(buf: Buffer, keyHex?: string): Dc09Parsed {
  const raw = buf.toString('binary');
  const stripped = stripFrame(buf);

  if (!stripped) {
    return {
      crcOk: false,
      token: '',
      encrypted: false,
      seq: '',
      receiver: '',
      prefix: '',
      account: '',
      data: '',
      timestamp: '',
      raw,
      length: 0,
      lengthOk: false,
    };
  }

  const declaredCrc = stripped.crc.toUpperCase();
  const declaredLen = parseInt(stripped.len, 16);
  const computedCrc = crc16Hex(stripped.body);
  const crcOk = computedCrc === declaredCrc;
  const lengthOk = !Number.isNaN(declaredLen) && declaredLen === stripped.body.length;

  const parsedBody = parseBody(stripped.body);

  // Optional AES decryption of the [data] block.
  if (parsedBody.encrypted && keyHex && parsedBody.data) {
    const dec = aesDecrypt(parsedBody.data, keyHex);
    if (dec != null) parsedBody.data = dec;
  }

  return {
    crcOk,
    lengthOk,
    length: Number.isNaN(declaredLen) ? 0 : declaredLen,
    raw: stripped.raw || raw,
    ...parsedBody,
  };
}

/**
 * Build a DC-09 ACK frame for a parsed message.
 *
 *   <LF> CRC LLLL "ACK"seq Rrcvr Lpfx #acct [] _timestamp <CR>
 *
 * NOTE: per DC-09 the ACK echoes the sequence, receiver, prefix and account
 * of the message being acknowledged, carries an empty [] data block and may
 * include a timestamp. Some receivers expect the timestamp echoed back; we
 * echo it when present.
 */
export function buildAck(parsed: Dc09Parsed): Buffer {
  const seq = parsed.seq || '0000';
  const rcvr = parsed.receiver ? `R${parsed.receiver}` : '';
  const pfx = parsed.prefix ? `L${parsed.prefix}` : '';
  const acct = parsed.account ? `#${parsed.account}` : '';
  const ts = parsed.timestamp ? `_${parsed.timestamp}` : '';

  // body = "ACK"seq Rrcvr Lpfx #acct [] _ts
  const body = `"ACK"${seq}${rcvr}${pfx}${acct}[]${ts}`;
  const crc = crc16Hex(body);
  const len = body.length.toString(16).toUpperCase().padStart(4, '0');
  const frame = `\n${crc}${len}${body}\r`;
  return Buffer.from(frame, 'binary');
}

/**
 * Build a NAK frame (used when CRC/length fails and the receiver wants to ask
 * for retransmission). Mirrors buildAck with the "NAK" token.
 */
export function buildNak(parsed: Dc09Parsed): Buffer {
  const seq = parsed.seq || '0000';
  const ts = parsed.timestamp ? `_${parsed.timestamp}` : '';
  const body = `"NAK"${seq}${ts}`;
  const crc = crc16Hex(body);
  const len = body.length.toString(16).toUpperCase().padStart(4, '0');
  return Buffer.from(`\n${crc}${len}${body}\r`, 'binary');
}

/**
 * Optional AES decryption of an encrypted [data] block.
 *
 * NOTE / spec assumption: DC-09 encryption uses AES in CBC mode with a
 * zero-ish IV scheme; the encrypted block is transmitted as ASCII hex. The
 * decrypted plaintext is padded on the left with pseudo-random bytes followed
 * by the real message, which begins at the first '[' or '|' separator. We
 * return the substring from the last '[' (the real SIA/CID block) when one is
 * found, else the whole decrypted text trimmed of control padding.
 *
 * Key length selects AES-128/192/256 from the hex key length (16/24/32 bytes).
 * Returns null on any failure (caller keeps the ciphertext).
 */
export function aesDecrypt(dataHex: string, keyHex: string): string | null {
  try {
    const key = Buffer.from(keyHex, 'hex');
    if (![16, 24, 32].includes(key.length)) return null;
    const cipher = Buffer.from(dataHex.replace(/[^0-9A-Fa-f]/g, ''), 'hex');
    if (cipher.length === 0 || cipher.length % 16 !== 0) return null;

    const algo = key.length === 16 ? 'aes-128-cbc' : key.length === 24 ? 'aes-192-cbc' : 'aes-256-cbc';
    // NOTE: DC-09 uses a zero IV with the padding carried inside the plaintext.
    const iv = Buffer.alloc(16, 0);
    const decipher = crypto.createDecipheriv(algo, key, iv);
    decipher.setAutoPadding(false);
    const out = Buffer.concat([decipher.update(cipher), decipher.final()]);
    const text = out.toString('binary');

    // Real message begins at the last '[' (SIA/CID block opener).
    const open = text.lastIndexOf('[');
    if (open >= 0) {
      const close = text.indexOf(']', open);
      return close >= 0 ? text.slice(open + 1, close) : text.slice(open + 1);
    }
    // Fallback: strip leading non-printable padding.
    // eslint-disable-next-line no-control-regex
    return text.replace(/^[\x00-\x1f|]+/, '');
  } catch {
    return null;
  }
}

/**
 * AES encryption helper (mirror of aesDecrypt) — useful for tests/simulator
 * that need to produce an encrypted frame. Returns uppercase hex or null.
 */
export function aesEncrypt(plain: string, keyHex: string): string | null {
  try {
    const key = Buffer.from(keyHex, 'hex');
    if (![16, 24, 32].includes(key.length)) return null;
    const algo = key.length === 16 ? 'aes-128-cbc' : key.length === 24 ? 'aes-192-cbc' : 'aes-256-cbc';
    const iv = Buffer.alloc(16, 0);
    const cipher = crypto.createCipheriv(algo, key, iv);
    cipher.setAutoPadding(false);
    // Left-pad with zero bytes to a 16-byte boundary (DC-09 pads the front).
    const body = Buffer.from(plain, 'binary');
    const padLen = (16 - (body.length % 16)) % 16;
    const padded = Buffer.concat([Buffer.alloc(padLen, 0), body]);
    const out = Buffer.concat([cipher.update(padded), cipher.final()]);
    return out.toString('hex').toUpperCase();
  } catch {
    return null;
  }
}

export default { parseDc09, buildAck, buildNak, crc16, crc16Hex, aesDecrypt, aesEncrypt };
