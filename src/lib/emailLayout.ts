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

export interface NotificationEmailInput {
  tenantName?: string;
  logoUrl?: string;
  eyebrow?: string;
  title: string;
  /** Plain text, may contain \n — escaped + nl2br by the renderer. */
  body: string;
  ctaText?: string;
  ctaUrl?: string;
  year?: number;
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
    const logoUrl = input.logoUrl ? String(input.logoUrl).trim() : '';
    if (logoUrl) {
      rendered = rendered.replace(/{{logoUrl}}/g, escapeHtml(logoUrl));
    } else {
      rendered = rendered.replace(/<img[^>]*\{\{logoUrl\}\}[^>]*\/?\s*>/g, '');
    }

    const tenantName = escapeHtml(input.tenantName || '');
    const eyebrow = escapeHtml(input.eyebrow || 'Notificación');
    const year = String(input.year || new Date().getFullYear());

    rendered = rendered.replace(/{{tenantName}}/g, tenantName);
    rendered = rendered.replace(/{{eyebrow}}/g, eyebrow);
    rendered = rendered.replace(/{{title}}/g, escapeHtml(title));
    rendered = rendered.replace(/{{body}}/g, escapeMultiline(body));
    rendered = rendered.replace(/{{year}}/g, year);

    return rendered;
  } catch (e) {
    return fallbackHtml(title, body);
  }
}

export default renderNotificationEmail;
