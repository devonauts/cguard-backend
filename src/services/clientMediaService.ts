/**
 * Async client media enrichment — a FALLBACK that runs only for fields the admin
 * left empty in the client form. Best-effort, never throws.
 *
 * Sources (in order):
 *  - logoUrl        ← website domain logo (Clearbit, no key → Google favicon)
 *  - placePictureUrl← website og:image (header), else Google Street View of the
 *                     client's coordinates (only if GOOGLE_STREETVIEW_KEY /
 *                     GOOGLE_MAPS_API_KEY is set and the location has imagery).
 *
 * Designed to be fire-and-forget: the caller does `void enrichClientMedia(...)`
 * AFTER the client is committed, so the create returns instantly and the images
 * appear on the next refresh. (For higher volume, move this onto a job queue.)
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import FileStorage from './file/fileStorage';

const UA = 'Mozilla/5.0 (compatible; CGuardPro/1.0; +https://cguardpro.com)';
const MAX_BYTES = 6 * 1024 * 1024;
const TIMEOUT_MS = 8000;

function siteUrl(website?: string | null): string | null {
  let s = String(website || '').trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  try { return new URL(s).toString(); } catch { return null; }
}
function domainOf(website?: string | null): string | null {
  const u = siteUrl(website);
  if (!u) return null;
  try { return new URL(u).hostname.replace(/^www\./i, ''); } catch { return null; }
}

function withTimeout(): { signal: any; done: () => void } {
  const AbortCtl: any = (globalThis as any).AbortController;
  const ctl = AbortCtl ? new AbortCtl() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), TIMEOUT_MS) : null;
  return { signal: ctl ? ctl.signal : undefined, done: () => { if (timer) clearTimeout(timer); } };
}

/** Download an image URL to a temp file; null unless it's a real image within size limits. */
async function fetchImageToTemp(url: string, label: string): Promise<{ path: string; mime: string; ext: string } | null> {
  const fetchFn: any = (globalThis as any).fetch;
  if (typeof fetchFn !== 'function' || !url) return null;
  const { signal, done } = withTimeout();
  try {
    const res = await fetchFn(url, { headers: { 'User-Agent': UA, Accept: 'image/*' }, redirect: 'follow', signal });
    if (!res || !res.ok) return null;
    const mime = String(res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!mime.startsWith('image/')) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length || buf.length > MAX_BYTES) return null;
    const ext = mime === 'image/png' ? 'png' : mime === 'image/svg+xml' ? 'svg' : mime === 'image/webp' ? 'webp' : mime === 'image/gif' ? 'gif' : 'jpg';
    const p = path.join(os.tmpdir(), `cm-${label}-${Date.now()}-${Math.round(Math.random() * 1e9)}.${ext}`);
    fs.writeFileSync(p, buf);
    return { path: p, mime, ext };
  } catch { return null; } finally { done(); }
}

async function fetchHtml(url: string): Promise<string | null> {
  const fetchFn: any = (globalThis as any).fetch;
  if (typeof fetchFn !== 'function' || !url) return null;
  const { signal, done } = withTimeout();
  try {
    const res = await fetchFn(url, { headers: { 'User-Agent': UA, Accept: 'text/html,*/*' }, redirect: 'follow', signal });
    if (!res || !res.ok) return null;
    const ct = String(res.headers.get('content-type') || '');
    if (ct && !ct.includes('html')) return null;
    return (await res.text()).slice(0, 500_000); // cap to the <head> region
  } catch { return null; } finally { done(); }
}

/** Pull a <meta property|name="…" content="…"> value (order = priority). */
function metaContent(html: string, props: string[]): string | null {
  for (const p of props) {
    const a = html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${p}["'][^>]*content=["']([^"']+)["']`, 'i'));
    if (a?.[1]) return a[1];
    const b = html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["']${p}["']`, 'i'));
    if (b?.[1]) return b[1];
  }
  return null;
}
function absUrl(maybe: string | null, base: string): string | null {
  if (!maybe) return null;
  try { return new URL(maybe, base).toString(); } catch { return null; }
}

/** Upload a temp image and attach it to the clientAccount as `column` (logoUrl/placePictureUrl). */
async function attachFile(
  db: any,
  opts: { tenantId: string; clientId: string; userId: string | null; column: 'logoUrl' | 'placePictureUrl'; tmp: { path: string; mime: string; ext: string } },
): Promise<void> {
  const { tenantId, clientId, userId, column, tmp } = opts;
  const name = `${column}-${Date.now()}.${tmp.ext}`;
  const privateUrl = `tenant/${tenantId}/clientAccount/${clientId}/${name}`;
  await FileStorage.upload(tmp.path, privateUrl);
  let size = 0; try { size = fs.statSync(tmp.path).size; } catch { /* ignore */ }
  await db.file.create({
    belongsTo: db.clientAccount.getTableName(),
    belongsToId: clientId,
    belongsToColumn: column,
    name,
    sizeInBytes: size,
    privateUrl,
    mimeType: tmp.mime,
    tenantId,
    createdById: userId,
    updatedById: userId,
  });
}

export async function enrichClientMedia(
  db: any,
  opts: {
    tenantId: string;
    clientAccountId: string;
    userId?: string | null;
    website?: string | null;
    latitude?: any;
    longitude?: any;
    hasLogo?: boolean;   // true → admin already supplied a logo; skip
    hasHeader?: boolean; // true → admin already supplied a header; skip
  },
): Promise<void> {
  try {
    const { tenantId, clientAccountId, userId = null } = opts;
    const site = siteUrl(opts.website);
    const domain = domainOf(opts.website);

    // ── Logo (website only) ────────────────────────────────────────────────
    if (!opts.hasLogo && domain) {
      try {
        let tmp = await fetchImageToTemp(`https://logo.clearbit.com/${encodeURIComponent(domain)}?size=256&format=png`, 'logo');
        if (!tmp) tmp = await fetchImageToTemp(`https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=128`, 'logo');
        if (tmp) { await attachFile(db, { tenantId, clientId: clientAccountId, userId, column: 'logoUrl', tmp }); fs.unlink(tmp.path, () => {}); }
      } catch (e: any) { console.warn('[clientMedia] logo failed:', e?.message || e); }
    }

    // ── Header: site og:image, else Street View of the location ────────────
    if (!opts.hasHeader) {
      let stored = false;
      if (site) {
        try {
          const html = await fetchHtml(site);
          const og = html ? absUrl(metaContent(html, ['og:image', 'og:image:url', 'og:image:secure_url', 'twitter:image', 'twitter:image:src']), site) : null;
          if (og) {
            const tmp = await fetchImageToTemp(og, 'header');
            if (tmp) { await attachFile(db, { tenantId, clientId: clientAccountId, userId, column: 'placePictureUrl', tmp }); fs.unlink(tmp.path, () => {}); stored = true; }
          }
        } catch (e: any) { console.warn('[clientMedia] og:image failed:', e?.message || e); }
      }
      if (!stored) {
        const key = process.env.GOOGLE_STREETVIEW_KEY || process.env.GOOGLE_MAPS_API_KEY || '';
        const lat = Number(opts.latitude), lng = Number(opts.longitude);
        if (key && Number.isFinite(lat) && Number.isFinite(lng)) {
          try {
            // Street View serves a gray "no imagery" image (HTTP 200) when none
            // exists — check metadata first so we only store a real photo.
            const fetchFn: any = (globalThis as any).fetch;
            const meta = await fetchFn(`https://maps.googleapis.com/maps/api/streetview/metadata?location=${lat},${lng}&key=${key}`).then((r: any) => r.json()).catch(() => null);
            if (meta && meta.status === 'OK') {
              const sv = `https://maps.googleapis.com/maps/api/streetview?size=640x320&location=${lat},${lng}&fov=80&pitch=0&source=outdoor&key=${key}`;
              const tmp = await fetchImageToTemp(sv, 'streetview');
              if (tmp) { await attachFile(db, { tenantId, clientId: clientAccountId, userId, column: 'placePictureUrl', tmp }); fs.unlink(tmp.path, () => {}); }
            }
          } catch (e: any) { console.warn('[clientMedia] streetview failed:', e?.message || e); }
        }
      }
    }
  } catch (e: any) {
    console.warn('[clientMedia] enrichClientMedia failed:', e?.message || e);
  }
}
