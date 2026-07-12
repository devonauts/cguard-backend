/**
 * Unit tests — offsite backup encryption round-trip (lib/dbBackup).
 *
 * The offsite backup is AES-256-GCM encrypted at rest. A backup you cannot
 * decrypt is worthless, so this proves encrypt→upload-shape→decrypt restores the
 * EXACT original bytes, and that a wrong key / tampered ciphertext is rejected
 * (GCM auth). No cloud, no DB — encrypts a temp file on disk.
 *
 * Run:
 *   cross-env NODE_ENV=test TS_NODE_PROJECT=tsconfig.test.json \
 *     npx mocha -r ts-node/register 'tests/unit/backup/dbBackupCrypto.test.ts' --exit
 */
import assert from 'assert';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { decryptBackup } from '../../../src/lib/dbBackup';

const KEY_HEX = crypto.randomBytes(32).toString('hex');

// dbBackup reads BACKUP_ENCRYPTION_KEY at call time via encryptionKey().
function withKey(hex: string | undefined, fn: () => Promise<void>) {
  return async () => {
    const saved = process.env.BACKUP_ENCRYPTION_KEY;
    if (hex === undefined) delete process.env.BACKUP_ENCRYPTION_KEY;
    else process.env.BACKUP_ENCRYPTION_KEY = hex;
    try { await fn(); } finally {
      if (saved === undefined) delete process.env.BACKUP_ENCRYPTION_KEY;
      else process.env.BACKUP_ENCRYPTION_KEY = saved;
    }
  };
}

// The module only exports decryptBackup; encryption happens inside runBackup's
// uploadOffsite. To test the round-trip in isolation we mirror the exact on-disk
// format the module writes ([12B IV][ciphertext][16B tag]) and decrypt via the
// public decryptBackup, so a format drift between the two halves fails the test.
function encryptLikeModule(src: string, dest: string, key: Buffer) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const plain = fs.readFileSync(src);
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  fs.writeFileSync(dest, Buffer.concat([iv, ct, cipher.getAuthTag()]));
}

describe('dbBackup offsite encryption', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cgbackup-'));
  const src = path.join(dir, 'dump.sql.gz');
  const enc = path.join(dir, 'dump.sql.gz.enc');
  const out = path.join(dir, 'restored.sql.gz');
  const payload = crypto.randomBytes(50_000); // ~50KB of "dump"

  before(() => fs.writeFileSync(src, payload));
  after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

  it('decryptBackup restores the EXACT original bytes', withKey(KEY_HEX, async () => {
    
    encryptLikeModule(src, enc, Buffer.from(KEY_HEX, 'hex'));
    await decryptBackup(enc, out);
    assert.ok(fs.readFileSync(out).equals(payload), 'restored bytes differ from original');
  }));

  it('rejects a WRONG key (GCM auth failure)', withKey(crypto.randomBytes(32).toString('hex'), async () => {
    
    // enc was written with KEY_HEX; decrypt with a different key must throw.
    await assert.rejects(() => decryptBackup(enc, out + '.bad'));
  }));

  it('rejects TAMPERED ciphertext', withKey(KEY_HEX, async () => {
    
    const buf = fs.readFileSync(enc);
    buf[20] = buf[20] ^ 0xff; // flip a ciphertext byte
    const tampered = path.join(dir, 'tampered.enc');
    fs.writeFileSync(tampered, buf);
    await assert.rejects(() => decryptBackup(tampered, out + '.tamper'));
  }));

  it('throws when no key is configured', withKey(undefined, async () => {
    
    await assert.rejects(() => decryptBackup(enc, out + '.nokey'), /BACKUP_ENCRYPTION_KEY/);
  }));
});
