/**
 * Ademco Contact ID (SIA DC-05) message parser.
 *
 * A Contact ID message is 16 hex digits:
 *
 *   ACCT  MT  Q  EEE  GG  ZZZ  S
 *
 *   ACCT (4)  account number (hex digits; 0 is sometimes sent as 'A')
 *   MT   (2)  message type: 18 (preferred) or 98 (older)
 *   Q    (1)  event qualifier: 1=new event/opening, 3=restore/closing,
 *             6=previously reported / status
 *   EEE  (3)  event code (e.g. 130 burglary)
 *   GG   (2)  group / partition number
 *   ZZZ  (3)  zone or user number
 *   S    (1)  checksum digit
 *
 * Checksum: the sum of all 16 digits (with the checksum digit's value being
 * 10 when it is 0, since '0' represents the value 10 in CID arithmetic) must
 * be a multiple of 15. We validate using the standard "sum mod 15 == 0" rule
 * where each digit's value is its hex value, and a digit value of 0 counts
 * as 10.
 *
 * Pure function. No DB.
 */

export interface ContactIdMessage {
  account: string;
  messageType: string; // '18' | '98'
  qualifier: string; // '1' | '3' | '6'
  eventCode: string; // 3 digits
  partition: string; // group/partition, 2 digits
  zone: string; // zone/user, 3 digits
  checksumOk: boolean;
  raw: string;
}

const HEX = '0123456789ABCDEF';

/**
 * CID digit value: hex value, but a literal 0 counts as 10 for the
 * checksum (per Ademco spec). 'A'..'F' are 10..15 and are used by some panels
 * to encode account/zone nibbles.
 */
function cidDigitValue(ch: string): number {
  const v = HEX.indexOf(ch.toUpperCase());
  if (v < 0) return -1;
  return v === 0 ? 10 : v;
}

/**
 * Parse a 16-digit Contact ID string. Non hex chars / wrong length -> the
 * fields are best-effort and checksumOk is false.
 */
export function parseContactId(input: string): ContactIdMessage {
  const digits = (input || '').replace(/[^0-9A-Fa-f]/g, '');
  const raw = input || '';

  const account = digits.slice(0, 4);
  const messageType = digits.slice(4, 6);
  const qualifier = digits.slice(6, 7);
  const eventCode = digits.slice(7, 10);
  const partition = digits.slice(10, 12);
  const zone = digits.slice(12, 15);

  let checksumOk = false;
  if (digits.length === 16) {
    let sum = 0;
    let valid = true;
    for (const ch of digits) {
      const v = cidDigitValue(ch);
      if (v < 0) {
        valid = false;
        break;
      }
      sum += v;
    }
    checksumOk = valid && sum % 15 === 0;
  }

  return {
    account,
    messageType,
    qualifier,
    eventCode,
    partition,
    zone,
    checksumOk,
    raw,
  };
}

/**
 * Human-readable qualifier label.
 */
export function contactIdQualifierLabel(qualifier: string): 'event' | 'restore' | 'status' | 'unknown' {
  switch (qualifier) {
    case '1':
      return 'event';
    case '3':
      return 'restore';
    case '6':
      return 'status';
    default:
      return 'unknown';
  }
}

export default { parseContactId, contactIdQualifierLabel };
