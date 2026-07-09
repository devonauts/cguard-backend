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
import fs from 'fs';
import path from 'path';

const BACKUP_DIR = process.env.BACKUP_DIR || path.join(process.env.HOME || '/home/cguardpro', 'db-backups');
const KEEP = Number(process.env.BACKUP_KEEP || 14);

let lastStatus: any = { ok: null, at: null, file: null, sizeBytes: null, error: null, durationMs: null, mirrored: false };

export function getBackupStatus(): any {
  let recent: any[] = [];
  try {
    recent = fs.readdirSync(BACKUP_DIR)
      .filter((f) => f.endsWith('.sql.gz'))
      .map((f) => { const st = fs.statSync(path.join(BACKUP_DIR, f)); return { file: f, sizeBytes: st.size, at: st.mtime.toISOString() }; })
      .sort((a, b) => (a.at < b.at ? 1 : -1))
      .slice(0, 20);
  } catch { /* dir may not exist yet */ }
  return { ...lastStatus, dir: BACKUP_DIR, keep: KEEP, mirrorDir: process.env.BACKUP_MIRROR_DIR || null, mirrorConfigured: !!process.env.BACKUP_MIRROR_DIR, recent };
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
    lastStatus = { ok: true, at: new Date().toISOString(), file: path.basename(file), sizeBytes, error: null, durationMs: Date.now() - started, mirrored };
    console.log(`[dbBackup] ok — ${path.basename(file)} (${(sizeBytes / 1e6).toFixed(1)}MB, mirrored=${mirrored})`);
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
