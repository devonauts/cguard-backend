/**
 * Alarm panel simulator — a TCP client that connects to the alarm receiver and
 * sends sample messages so the parsing/ingest pipeline can be exercised without
 * real hardware:
 *
 *   - a SIA DC-09 "SIA-DCS" frame (native SIA burglary alarm),
 *   - a SIA DC-09 "ADM-CID" frame (Contact ID payload, fire alarm),
 *   - a bare Sur-Gard automation line (hardware-receiver style).
 *
 * It prints whatever the receiver replies (the DC-09 ACK for DC-09 frames).
 *
 *   Run:  npx ts-node src/scripts/alarmSimulator.ts [host] [port] [account]
 *   e.g.  npx ts-node src/scripts/alarmSimulator.ts 127.0.0.1 6543 1234
 *
 * NOTE: the receiver resolves the owning tenant by `account`, so use an
 * accountNumber that exists on an alarmPanel (otherwise the signal is recorded
 * but no case is opened and DC-09 frames are NOT ACKed).
 */

import * as net from 'net';
import { crc16Hex } from '../services/alarm/protocols/siaDc09';

const host = process.argv[2] || '127.0.0.1';
const port = Number(process.argv[3]) || 6543;
const account = process.argv[4] || '1234';

/** Build a DC-09 frame: <LF>CRC LLLL body<CR>, CRC/len over the body. */
function buildDc09(body: string): Buffer {
  const crc = crc16Hex(body);
  const len = body.length.toString(16).toUpperCase().padStart(4, '0');
  return Buffer.from(`\n${crc}${len}${body}\r`, 'binary');
}

function siaTimestamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  // _HH:MM:SS,MM-DD-YYYY
  return `_${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())},` +
    `${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}-${d.getUTCFullYear()}`;
}

/** A native SIA-DCS burglary alarm on zone 01, partition 1. */
function siaDcsFrame(seq = '0001'): Buffer {
  // body: "SIA-DCS"seq Rrcvr Lpfx #acct [data] _ts
  const body = `"SIA-DCS"${seq}R0001L0001#${account}[Nri1/BA01]${siaTimestamp()}`;
  return buildDc09(body);
}

/** Build a 16-digit Contact ID string (with valid checksum) for a fire alarm. */
function contactIdDigits(acct: string, qualifier: string, code: string, group: string, zone: string): string {
  const acct4 = acct.replace(/[^0-9A-Fa-f]/g, '').padStart(4, '0').slice(-4);
  const mt = '18';
  const base = `${acct4}${mt}${qualifier}${code}${group}${zone}`; // 15 digits
  // checksum digit so the sum (0 counts as 10) is a multiple of 15.
  const val = (ch: string) => {
    const v = parseInt(ch, 16);
    return v === 0 ? 10 : v;
  };
  let sum = 0;
  for (const ch of base) sum += val(ch);
  let cs = (15 - (sum % 15)) % 15; // needed digit value 0..14
  if (cs === 0) cs = 0; // value 0 is written as '0' (counts as 10 -> adjust)
  // If we need value 10, that is written as '0'. Map value->digit:
  // values 1..9 -> '1'..'9'; value 10 -> '0'; values 11..14 -> 'B'..'E'.
  let csDigit: string;
  if (cs === 0) {
    // sum already multiple of 15 -> need digit contributing 15? not possible;
    // a contributing value of 10 ('0') keeps multiple-of-15 only if sum%15==5.
    csDigit = '0';
  } else if (cs === 10) {
    csDigit = '0';
  } else if (cs >= 1 && cs <= 9) {
    csDigit = String(cs);
  } else {
    csDigit = 'ABCDEF'[cs - 10];
  }
  return base + csDigit;
}

/** A DC-09 ADM-CID frame carrying a Contact ID fire alarm (110) on zone 005. */
function admCidFrame(seq = '0002'): Buffer {
  const cid = contactIdDigits(account, '1', '110', '01', '005');
  const body = `"ADM-CID"${seq}R0001L0001#${account}[${cid}]${siaTimestamp()}`;
  return buildDc09(body);
}

/** A bare Sur-Gard automation line: receiver line account E<code> part zone. */
function surgardLine(): Buffer {
  // "5061 18 <acct> E130 01 005" -> burglary (130) on zone 005, partition 01.
  const line = `5061 18 ${account} E130 01 005\r\n`;
  return Buffer.from(line, 'binary');
}

function show(label: string, buf: Buffer): void {
  console.log(`\n>>> ${label}:`);
  console.log(JSON.stringify(buf.toString('binary')));
}

async function main() {
  console.log(`[simulator] connecting to ${host}:${port} (account=${account})`);
  const socket = net.createConnection({ host, port });

  socket.setEncoding('binary');
  socket.on('connect', async () => {
    console.log('[simulator] connected');

    const frames: Array<{ label: string; buf: Buffer }> = [
      { label: 'SIA-DCS burglary (BA01)', buf: siaDcsFrame('0001') },
      { label: 'ADM-CID fire (CID 110)', buf: admCidFrame('0002') },
      { label: 'Sur-Gard line (CID 130)', buf: surgardLine() },
    ];

    for (const f of frames) {
      show(`SEND ${f.label}`, f.buf);
      socket.write(f.buf);
      // Give the receiver time to persist + reply between frames.
      await new Promise((r) => setTimeout(r, 600));
    }

    // Allow any final ACK to arrive, then close.
    setTimeout(() => {
      console.log('\n[simulator] done; closing.');
      socket.end();
    }, 800);
  });

  socket.on('data', (data: any) => {
    const buf = Buffer.from(String(data), 'binary');
    console.log(`<<< ACK/reply: ${JSON.stringify(buf.toString('binary'))}`);
  });

  socket.on('error', (e: any) => {
    console.error('[simulator] socket error:', e?.message || e);
    process.exit(1);
  });
  socket.on('close', () => {
    console.log('[simulator] connection closed');
    process.exit(0);
  });
}

main().catch((e) => {
  console.error('[simulator] error:', e instanceof Error ? e.message : e);
  process.exit(1);
});
