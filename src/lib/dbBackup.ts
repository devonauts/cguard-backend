/**
 * Automated MySQL backups — the missing piece for "no backups". A daily
 * leader-elected job (server.ts) runs mysqldump → gzip → BACKUP_DIR, rotates to
 * the last BACKUP_KEEP, and (optionally) mirrors each dump to a SECOND LOCAL
 * path (BACKUP_MIRROR_DIR — e.g. a second disk or a NAS mount on the same box)
 * so a single disk failure doesn't lose everything. All local, no cloud. Status
 * shows in the superadmin "Copias" view + the Jobs panel (runJob('DbBackup')).
 *
 * Env: BACKUP_DIR (default ~/db-backups), BACKUP_KEEP (14),
 *      BACKUP_MIRROR_DIR (optional second local/mounted path).
 */
import { exec } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const BACKUP_DIR = process.env.BACKUP_DIR || path.join(process.env.HOME || '/home/cguardpro', 'db-backups');
const KEEP = Number(process.env.BACKUP_KEEP || 14);
const OFFSITE_KEEP = Number(process.env.BACKUP_OFFSITE_KEEP || 30);

let lastStatus: any = { ok: null, at: null, file: null, sizeBytes: null, error: null, durationMs: null, mirrored: false, offsite: null };

export function getBackupStatus(): any {
  let recent: any[] = [];
  try {
    recent = fs.readdirSync(BACKUP_DIR)
      .filter((f) => f.endsWith('.sql.gz'))
      .map((f) => { const st = fs.statSync(path.join(BACKUP_DIR, f)); return { file: f, sizeBytes: st.size, at: st.mtime.toISOString() }; })
      .sort((a, b) => (a.at < b.at ? 1 : -1))
      .slice(0, 20);
  } catch { /* dir may not exist yet */ }
  const offsiteConfigured = !!process.env.BACKUP_SSH_HOST;
  return {
    ...lastStatus,
    dir: BACKUP_DIR,
    keep: KEEP,
    mirrorDir: process.env.BACKUP_MIRROR_DIR || null,
    mirrorConfigured: !!process.env.BACKUP_MIRROR_DIR,
    offsiteProvider: offsiteConfigured ? 'ssh' : null,
    offsiteHost: process.env.BACKUP_SSH_HOST || null,
    offsiteConfigured,
    offsiteEncrypted: !!process.env.BACKUP_ENCRYPTION_KEY,
    recent,
  };
}

/** How old (ms) is the newest backup on disk? Infinity if none. */
function newestBackupAgeMs(): number {
  try {
    const files = fs.readdirSync(BACKUP_DIR).filter((f) => f.endsWith('.sql.gz'));
    if (!files.length) return Infinity;
    const newest = Math.max(...files.map((f) => fs.statSync(path.join(BACKUP_DIR, f)).mtimeMs));
    return Date.now() - newest;
  } catch { return Infinity; }
}

/** Run a backup only if the newest is older than ~20h (avoids re-dumping on every deploy). */
export async function runBackupIfStale(): Promise<void> {
  if (newestBackupAgeMs() > 20 * 3600 * 1000) await runBackup();
}

export async function runBackup(): Promise<any> {
  const started = Date.now();
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const db = process.env.DATABASE_DATABASE;
    if (!db) throw new Error('DATABASE_DATABASE not set');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(BACKUP_DIR, `${db}-${stamp}.sql.gz`);
    const host = process.env.DATABASE_HOST || '127.0.0.1';
    const port = process.env.DATABASE_PORT || '3306';
    const user = process.env.DATABASE_USERNAME || 'root';
    // Password via MYSQL_PWD env (NOT argv → not visible in `ps`).
    const cmd = `mysqldump --single-transaction --quick --routines --host=${host} --port=${port} --user=${user} ${db} | gzip > "${file}"`;
    await new Promise<void>((resolve, reject) => {
      exec(cmd, { env: { ...process.env, MYSQL_PWD: process.env.DATABASE_PASSWORD || '' }, maxBuffer: 1024 * 1024 * 128 },
        (err) => (err ? reject(err) : resolve()));
    });
    const sizeBytes = fs.statSync(file).size;
    if (sizeBytes < 1000) throw new Error(`backup file suspiciously small (${sizeBytes} bytes) — dump likely failed`);
    rotate();
    const mirrored = mirrorBackup(file);
    // Offsite (encrypted) replication — the piece that survives disk/theft/
    // ransomware on the box. Failure here must NOT fail the (successful) local
    // backup, so it's caught and reported separately.
    const offsite = await uploadOffsite(file).catch((e: any) => ({ ok: false, error: e?.message || String(e) }));
    lastStatus = { ok: true, at: new Date().toISOString(), file: path.basename(file), sizeBytes, error: null, durationMs: Date.now() - started, mirrored, offsite };
    console.log(`[dbBackup] ok — ${path.basename(file)} (${(sizeBytes / 1e6).toFixed(1)}MB, mirrored=${mirrored}, offsite=${offsite ? (offsite.ok ? offsite.provider : 'FAILED') : 'off'})`);
    return lastStatus;
  } catch (e: any) {
    lastStatus = { ok: false, at: new Date().toISOString(), file: null, sizeBytes: null, error: e?.message || String(e), durationMs: Date.now() - started, mirrored: false };
    console.error('[dbBackup] FAILED:', lastStatus.error);
    return lastStatus;
  }
}

function rotate(): void {
  try {
    const files = fs.readdirSync(BACKUP_DIR)
      .filter((f) => f.endsWith('.sql.gz'))
      .map((f) => ({ f, t: fs.statSync(path.join(BACKUP_DIR, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const { f } of files.slice(KEEP)) { try { fs.unlinkSync(path.join(BACKUP_DIR, f)); } catch { /* skip */ } }
  } catch { /* best-effort */ }
}

/** Copy the dump to a second LOCAL path (another disk / mounted NAS) if set. */
function mirrorBackup(file: string): boolean {
  const dir = process.env.BACKUP_MIRROR_DIR;
  if (!dir) return false;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(file, path.join(dir, path.basename(file)));
    // keep the mirror rotated too
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql.gz'))
      .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs })).sort((a, b) => b.t - a.t);
    for (const { f } of files.slice(KEEP)) { try { fs.unlinkSync(path.join(dir, f)); } catch { /* skip */ } }
    return true;
  } catch (e: any) {
    console.error('[dbBackup] mirror copy failed:', e?.message || e);
    return false;
  }
}

// ── Offsite replication (self-hosted, encrypted rsync-over-SSH) ───────────────
// The audit's #1 CRITICAL: backups were local-only, so a disk/theft/ransomware
// event lost all history (legal evidence). This ships each dump to a SECOND
// MACHINE YOU OWN over SSH (ideally in another location) — no cloud, no S3 —
// AES-256-GCM-encrypted at rest when BACKUP_ENCRYPTION_KEY is set.
//
// Env:
//   BACKUP_SSH_HOST — remote host (e.g. "192.168.1.50" or "user@host"). Enables offsite.
//   BACKUP_SSH_USER — remote user (optional if already in BACKUP_SSH_HOST)
//   BACKUP_SSH_PATH — remote directory (default "cguard-db-backups", relative to $HOME)
//   BACKUP_SSH_PORT — default 22
//   BACKUP_SSH_KEY  — path to the SSH private key (optional; else default agent/key)
//   BACKUP_ENCRYPTION_KEY — 32 bytes as 64-hex or base64 (STRONGLY recommended;
//                           a DB dump is full of PII + legal records)
//   BACKUP_OFFSITE_KEEP (default 30)
// Setup on the remote box: add this server's public key to ~/.ssh/authorized_keys.
// Restore: pull the .enc back and run decryptBackup() (see bottom of file).
import { execFile } from 'child_process';

/** Parse the 32-byte AES key from env (64-hex or base64), or null if unusable. */
function encryptionKey(): Buffer | null {
  const raw = process.env.BACKUP_ENCRYPTION_KEY;
  if (!raw) return null;
  let key: Buffer | null = null;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) key = Buffer.from(raw, 'hex');
  else { try { const b = Buffer.from(raw, 'base64'); if (b.length === 32) key = b; } catch { /* not base64 */ } }
  if (!key || key.length !== 32) {
    console.error('[dbBackup] BACKUP_ENCRYPTION_KEY must be 32 bytes (64 hex or base64) — offsite copy will be UNENCRYPTED');
    return null;
  }
  return key;
}

/**
 * AES-256-GCM encrypt a file → `<file>.enc` with layout [12B IV][ciphertext][16B tag].
 * Streamed so large dumps never load into memory. Returns the .enc path.
 */
async function encryptFile(src: string, key: Buffer): Promise<string> {
  const dest = `${src}.enc`;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  await new Promise<void>((resolve, reject) => {
    const input = fs.createReadStream(src);
    const output = fs.createWriteStream(dest);
    output.on('error', reject);
    input.on('error', reject);
    cipher.on('error', reject);
    output.write(iv);
    cipher.pipe(output, { end: false });
    cipher.on('end', () => { output.end(cipher.getAuthTag()); });
    output.on('finish', () => resolve());
    input.pipe(cipher);
  });
  return dest;
}

/** Run a binary with args (no shell → no quoting/injection surface). */
function run(bin: string, args: string[], timeoutMs = 10 * 60 * 1000): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: timeoutMs }, (err, _out, stderr) => {
      if (err) { (err as any).stderr = stderr; reject(err); } else resolve();
    });
  });
}

/** The ssh transport args shared by rsync (-e) and the mkdir/prune ssh calls. */
function sshParts(): { eString: string; sshArgs: string[]; target: string; remoteDir: string } | null {
  const host = process.env.BACKUP_SSH_HOST;
  if (!host) return null; // offsite not configured
  const user = process.env.BACKUP_SSH_USER;
  const target = user && !host.includes('@') ? `${user}@${host}` : host;
  const port = String(process.env.BACKUP_SSH_PORT || '22').replace(/[^0-9]/g, '') || '22';
  const keyPath = process.env.BACKUP_SSH_KEY;
  const remoteDir = (process.env.BACKUP_SSH_PATH || 'cguard-db-backups').replace(/\/+$/, '');
  const opts = ['-o', 'StrictHostKeyChecking=accept-new', '-o', 'BatchMode=yes'];
  const sshArgs = ['-p', port, ...(keyPath ? ['-i', keyPath] : []), ...opts];
  // rsync's -e wants ONE string; keyPath is assumed space-free (document it).
  const eString = `ssh -p ${port}${keyPath ? ` -i ${keyPath}` : ''} -o StrictHostKeyChecking=accept-new -o BatchMode=yes`;
  return { eString, sshArgs, target, remoteDir };
}

/** Ship the dump (encrypted when a key is set) to a second box over SSH. Prunes old files. */
async function uploadOffsite(file: string): Promise<any> {
  const cfg = sshParts();
  if (!cfg) return null; // BACKUP_SSH_HOST unset → offsite not configured

  const key = encryptionKey();
  let uploadPath = file;
  let encrypted = false;
  let tmpEnc: string | null = null;
  try {
    if (key) {
      tmpEnc = await encryptFile(file, key);
      uploadPath = tmpEnc;
      encrypted = true;
    }
    const name = path.basename(uploadPath);
    const size = fs.statSync(uploadPath).size;

    // Ensure the remote directory exists, then rsync the file over.
    await run('ssh', [...cfg.sshArgs, cfg.target, `mkdir -p '${cfg.remoteDir}'`]);
    await run('rsync', ['-az', '--partial', '-e', cfg.eString, uploadPath, `${cfg.target}:${cfg.remoteDir}/`]);
    await pruneRemote(cfg).catch(() => {});
    return { ok: true, provider: 'ssh', host: cfg.target, path: `${cfg.remoteDir}/${name}`, encrypted, sizeBytes: size };
  } finally {
    if (tmpEnc) { try { fs.unlinkSync(tmpEnc); } catch { /* best-effort */ } }
  }
}

/** Keep only the newest OFFSITE_KEEP backups in the remote directory. */
async function pruneRemote(cfg: { sshArgs: string[]; target: string; remoteDir: string }): Promise<void> {
  const cmd =
    `cd '${cfg.remoteDir}' && ls -1t *.sql.gz.enc *.sql.gz 2>/dev/null | tail -n +${OFFSITE_KEEP + 1} | xargs -r rm -f`;
  await run('ssh', [...cfg.sshArgs, cfg.target, cmd]);
}

/**
 * Restore helper: decrypt a `.enc` offsite backup back to gzip. Run manually:
 *   BACKUP_ENCRYPTION_KEY=... npx ts-node -e \
 *     "require('./src/lib/dbBackup').decryptBackup('dump.sql.gz.enc','dump.sql.gz')"
 * then `gunzip dump.sql.gz && mysql < dump.sql`.
 */
export async function decryptBackup(encPath: string, outPath: string): Promise<void> {
  const key = encryptionKey();
  if (!key) throw new Error('BACKUP_ENCRYPTION_KEY not set / invalid');
  const stat = fs.statSync(encPath);
  const fd = fs.openSync(encPath, 'r');
  try {
    const iv = Buffer.alloc(12);
    fs.readSync(fd, iv, 0, 12, 0);
    const tag = Buffer.alloc(16);
    fs.readSync(fd, tag, 0, 16, stat.size - 16);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    await new Promise<void>((resolve, reject) => {
      const input = fs.createReadStream(encPath, { start: 12, end: stat.size - 17 });
      const output = fs.createWriteStream(outPath);
      input.on('error', reject); decipher.on('error', reject); output.on('error', reject);
      output.on('finish', () => resolve());
      input.pipe(decipher).pipe(output);
    });
  } finally {
    fs.closeSync(fd);
  }
}
