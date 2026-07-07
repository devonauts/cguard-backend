/**
 * One-time migration: copy every local upload (UPLOAD_DIR, default ./uploads) to
 * S3 under the SAME key the app uses (key = path relative to UPLOAD_DIR =
 * privateUrl), so switching FILE_STORAGE_PROVIDER=aws serves existing files too.
 *
 * This is the last horizontal-scaling P0: while files live on local disk you
 * cannot run more than one app box. After this + FILE_STORAGE_PROVIDER=aws, the
 * box is stateless for files.
 *
 * Requires (in .env): FILE_STORAGE_BUCKET, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY,
 * AWS_REGION. Idempotent: skips objects that already exist (pass --force to overwrite).
 *
 * Run:  npx ts-node scripts/migrate-uploads-to-s3.ts [--force] [--dry]
 * Then: set FILE_STORAGE_PROVIDER=aws in .env and reload PM2.
 */
require('dotenv').config();
import fs from 'fs';
import path from 'path';
import { S3Client, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';

const UPLOAD_DIR = process.env.UPLOAD_DIR || path.resolve(process.cwd(), 'uploads');
const BUCKET = process.env.FILE_STORAGE_BUCKET;
const REGION = process.env.AWS_REGION;
const FORCE = process.argv.includes('--force');
const DRY = process.argv.includes('--dry');

function walk(dir: string, base: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, base, out);
    else out.push(path.relative(base, full).split(path.sep).join('/')); // key = relative posix path
  }
  return out;
}

async function main() {
  if (!BUCKET || !process.env.AWS_ACCESS_KEY_ID) {
    console.error('Missing FILE_STORAGE_BUCKET / AWS_ACCESS_KEY_ID. Set them in .env first.');
    process.exit(1);
  }
  if (!fs.existsSync(UPLOAD_DIR)) {
    console.log(`No upload dir at ${UPLOAD_DIR} — nothing to migrate.`);
    process.exit(0);
  }
  const s3 = new S3Client({ region: REGION });
  const keys = walk(UPLOAD_DIR, UPLOAD_DIR);
  console.log(`Found ${keys.length} files under ${UPLOAD_DIR} → bucket ${BUCKET}${DRY ? ' (DRY RUN)' : ''}`);

  let uploaded = 0, skipped = 0, failed = 0;
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const file = path.join(UPLOAD_DIR, key);
    try {
      if (!FORCE) {
        try { await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key })); skipped++; continue; } catch { /* not present → upload */ }
      }
      if (!DRY) {
        await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: fs.readFileSync(file) }));
      }
      uploaded++;
      if (uploaded % 100 === 0) console.log(`  …${uploaded} uploaded`);
    } catch (e: any) {
      failed++;
      console.error(`  FAILED ${key}: ${e?.message || e}`);
    }
  }
  console.log(`Done. uploaded=${uploaded} skipped(existing)=${skipped} failed=${failed}`);
  console.log(failed ? 'Some files failed — re-run to retry (idempotent).' : 'All good. Now set FILE_STORAGE_PROVIDER=aws and reload.');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
