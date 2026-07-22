/**
 * emailLayout — renders the company's global branded notification email.
 *
 * Wraps plain-text router notifications (shift reminders, incident/visitor/ronda/
 * no-show alerts, etc.) in the same navy/gold 600px card style as
 * email-templates/passwordReset.html. Dependency-free; uses the same simple
 * {{...}} string-replace convention the rest of the codebase already relies on.
 *
 * The renderer NEVER throws — on any failure it returns a minimal inline-styled
 * fallback so notification emails still go out.
 */
import fs from 'fs';
import path from 'path';

const TEMPLATE_FILE = 'notification.html';

/** Cache the template after the first successful read (file is immutable at runtime). */
let cachedTemplate: string | null = null;

/** Load the template from cwd first, then relative to this file (works in src via ts-node AND compiled dist). */
function loadTemplate(): string | null {
  if (cachedTemplate) return cachedTemplate;
  const candidates = [
    path.resolve(process.cwd(), 'email-templates', TEMPLATE_FILE),
    path.resolve(__dirname, '..', '..', 'email-templates', TEMPLATE_FILE),
  ];
  for (const p of candidates) {
    try {
      const html = fs.readFileSync(p, 'utf-8');
      cachedTemplate = html;
      return html;
    } catch (e) {
      // try next candidate
    }
  }
  return null;
}

/** HTML-escape user/tenant supplied text to prevent broken markup / injection. */
function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Escape then convert newlines to <br> for the body paragraph. */
function escapeMultiline(s: string): string {
  return escapeHtml(s).replace(/\r\n|\r|\n/g, '<br>');
}

/** Default brand accent (gold) + header (navy) when a tenant hasn't customized. */
export const DEFAULT_BRAND_COLOR = '#C8860A';
export const DEFAULT_HEADER_COLOR = '#0A0E16';
const HEX_RE = /^#[0-9a-fA-F]{6}$/;
export function safeHex(v: any, fallback: string): string {
  const s = String(v || '').trim();
  return HEX_RE.test(s) ? s : fallback;
}

export interface NotificationEmailInput {
  tenantName?: string;
  logoUrl?: string;
  eyebrow?: string;
  title: string;
  /** Plain text, may contain \n — escaped + nl2br by the renderer. */
  body: string;
  /**
   * Raw HTML content for the body slot (already-trusted template fragment).
   * When set, it REPLACES the title+body text block entirely — used to wrap the
   * per-event emailHtml() fragments in the branded shell without escaping.
   */
  bodyHtml?: string;
  ctaText?: string;
  ctaUrl?: string;
  year?: number;
  /** Accent color (eyebrow, divider, CTA). Defaults to gold. */
  brandColor?: string;
  /** Header bar background. Defaults to dark navy (keeps white text legible). */
  headerColor?: string;
}

/** Minimal inline-styled fallback used when the template file can't be loaded. */
function fallbackHtml(title: string, body: string): string {
  return (
    `<div style="font-family:'Segoe UI',Arial,Helvetica,sans-serif; max-width:600px; margin:0 auto; padding:24px; color:#374151;">` +
    `<h1 style="color:#0A0E16; font-size:22px; font-weight:800; margin:0 0 16px;">${escapeHtml(title)}</h1>` +
    `<p style="font-size:15px; line-height:1.7; margin:0;">${escapeMultiline(body)}</p>` +
    `</div>`
  );
}

/**
 * Render the branded notification email. Returns a complete HTML string and
 * never throws — callers can rely on always getting usable HTML.
 */
export function renderNotificationEmail(input: NotificationEmailInput): string {
  const title = input.title || 'Notificación';
  const body = input.body || '';

  try {
    const template = loadTemplate();
    if (!template) return fallbackHtml(title, body);

    let rendered = template;

    // CTA block — keep it only when we have an https(ish) URL, otherwise strip the
    // whole commented wrapper so no empty button is shown.
    const ctaUrl = input.ctaUrl ? String(input.ctaUrl).trim() : '';
    if (ctaUrl) {
      rendered = rendered.replace(/<!--CTA_START-->|<!--CTA_END-->/g, '');
      rendered = rendered.replace(/{{ctaUrl}}/g, escapeHtml(ctaUrl));
      rendered = rendered.replace(/{{ctaText}}/g, escapeHtml(input.ctaText || 'Ver detalle'));
    } else {
      rendered = rendered.replace(/<!--CTA_START-->[\s\S]*?<!--CTA_END-->/g, '');
    }

    // Logo — strip the <img> entirely when no tenant logo is available (mirrors emailSender).
    // Re-sign a raw privateUrl logo as a public fileToken URL so it loads in email
    // clients (a raw privateUrl now 403s unauthenticated after the IDOR fix).
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { toPublicFileUrl } = require('../utils/privateUrlEncryption');
    const logoUrl = input.logoUrl ? toPublicFileUrl(String(input.logoUrl).trim()) : '';
    if (logoUrl) {
      rendered = rendered.replace(/{{logoUrl}}/g, escapeHtml(logoUrl));
    } else {
      rendered = rendered.replace(/<img[^>]*\{\{logoUrl\}\}[^>]*\/?\s*>/g, '');
    }

    // Body slot: a trusted HTML fragment REPLACES the whole title+body block;
    // otherwise render the escaped title + nl2br body text.
    if (input.bodyHtml != null) {
      rendered = rendered.replace(
        /<!--CONTENT_START-->[\s\S]*?<!--CONTENT_END-->/g,
        String(input.bodyHtml),
      );
    } else {
      rendered = rendered.replace(/<!--CONTENT_START-->|<!--CONTENT_END-->/g, '');
      rendered = rendered.replace(/{{title}}/g, escapeHtml(title));
      rendered = rendered.replace(/{{body}}/g, escapeMultiline(body));
    }

    const tenantName = escapeHtml(input.tenantName || '');
    const eyebrow = escapeHtml(input.eyebrow || 'Notificación');
    const year = String(input.year || new Date().getFullYear());
    const brandColor = safeHex(input.brandColor, DEFAULT_BRAND_COLOR);
    const headerColor = safeHex(input.headerColor, DEFAULT_HEADER_COLOR);

    rendered = rendered.replace(/{{tenantName}}/g, tenantName);
    rendered = rendered.replace(/{{eyebrow}}/g, eyebrow);
    rendered = rendered.replace(/{{title}}/g, escapeHtml(title));
    rendered = rendered.replace(/{{year}}/g, year);
    rendered = rendered.replace(/{{brandColor}}/g, brandColor);
    rendered = rendered.replace(/{{headerColor}}/g, headerColor);

    return rendered;
  } catch (e) {
    return fallbackHtml(title, body);
  }
}

export interface TenantEmailBranding {
  brandColor: string;
  headerColor: string;
  logoUrl: string;
  tenantName: string;
}

/**
 * Resolve a tenant's email branding (accent + header color, logo, name) from
 * the settings row + tenant. Best-effort — always returns usable defaults.
 * Cached briefly so the dispatcher doesn't re-query on every email.
 */
const brandingCache = new Map<string, { at: number; value: TenantEmailBranding }>();
const BRANDING_TTL_MS = 60_000;

export async function getEmailBranding(db: any, tenantId: string): Promise<TenantEmailBranding> {
  const fallback: TenantEmailBranding = {
    brandColor: DEFAULT_BRAND_COLOR,
    headerColor: DEFAULT_HEADER_COLOR,
    logoUrl: '',
    tenantName: '',
  };
  if (!db || !tenantId) return fallback;
  const cached = brandingCache.get(tenantId);
  if (cached && Date.now() - cached.at < BRANDING_TTL_MS) return cached.value;
  try {
    const settings = await db.settings.findOne({ where: { tenantId } });
    let branding: any = settings && (settings.emailBranding || settings.get?.('emailBranding'));
    if (typeof branding === 'string') { try { branding = JSON.parse(branding); } catch { branding = null; } }
    const tenant = await db.tenant.findByPk(tenantId, { attributes: ['name'] });
    const value: TenantEmailBranding = {
      brandColor: safeHex(branding?.brandColor, DEFAULT_BRAND_COLOR),
      headerColor: safeHex(branding?.headerColor, DEFAULT_HEADER_COLOR),
      logoUrl: (settings && (settings.logoUrl || settings.get?.('logoUrl'))) || '',
      tenantName: (tenant && tenant.name) || '',
    };
    brandingCache.set(tenantId, { at: Date.now(), value });
    return value;
  } catch {
    return fallback;
  }
}

/** Invalidate the branding cache for a tenant (call after a branding save). */
export function clearEmailBrandingCache(tenantId?: string) {
  if (tenantId) brandingCache.delete(tenantId);
  else brandingCache.clear();
}

export default renderNotificationEmail;
