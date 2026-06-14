import crypto from 'crypto';
import { getConfig } from '../config';

/**
 * Issues "C-Guard Pro" branded training certificates.
 *
 * No heavy PDF dependency: we render a branded, print-ready HTML document with
 * CSS print styles. The guard app can display it (WebView/iframe) and the
 * browser's print-to-PDF handles download. A stateless `downloadToken` allows
 * public, unauthenticated sharing/validation.
 */
export default class TrainingCertificateService {
  /** CG-TRAIN-YYYY-XXXXXX (6 uppercase alnum chars). */
  static generateSerial(): string {
    const year = new Date().getFullYear();
    const rand = crypto.randomBytes(4).toString('hex').toUpperCase().slice(0, 6);
    return `CG-TRAIN-${year}-${rand}`;
  }

  /** base64url(id|tenantId|timestamp) — opaque, stateless share token. */
  static generateDownloadToken(id: string, tenantId: string): string {
    const raw = `${id}|${tenantId}|${Date.now()}`;
    return Buffer.from(raw).toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  }

  static publicUrlFor(token: string): string {
    const base = (getConfig().FRONTEND_URL || getConfig().APP_URL || 'https://cguard-pro.com')
      .toString()
      .replace(/\/$/, '');
    return `${base}/public/training/cert/${token}`;
  }

  private static esc(s: any): string {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /**
   * Render the branded certificate HTML. If the course supplies a
   * `certificateTemplate`, simple {{token}} placeholders are interpolated;
   * otherwise the default C-Guard Pro template is used.
   */
  static renderHtml(opts: {
    guardName: string;
    courseTitle: string;
    score?: number | null;
    serialNumber: string;
    issuedAt: Date;
    tenantName?: string | null;
    publicUrl?: string | null;
    template?: string | null;
  }): string {
    const issued = opts.issuedAt instanceof Date ? opts.issuedAt : new Date(opts.issuedAt);
    const dateStr = issued.toLocaleDateString('es-ES', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });

    if (opts.template && opts.template.includes('{{')) {
      return opts.template
        .replace(/\{\{\s*guardName\s*\}\}/g, this.esc(opts.guardName))
        .replace(/\{\{\s*courseTitle\s*\}\}/g, this.esc(opts.courseTitle))
        .replace(/\{\{\s*score\s*\}\}/g, this.esc(opts.score != null ? `${opts.score}%` : ''))
        .replace(/\{\{\s*serialNumber\s*\}\}/g, this.esc(opts.serialNumber))
        .replace(/\{\{\s*issuedAt\s*\}\}/g, this.esc(dateStr))
        .replace(/\{\{\s*tenantName\s*\}\}/g, this.esc(opts.tenantName || ''))
        .replace(/\{\{\s*publicUrl\s*\}\}/g, this.esc(opts.publicUrl || ''));
    }

    const scoreLine = opts.score != null
      ? `<p class="score">Calificación obtenida: <strong>${this.esc(opts.score)}%</strong></p>`
      : '';
    const tenantLine = opts.tenantName
      ? `<p class="tenant">${this.esc(opts.tenantName)}</p>`
      : '';

    return `<!DOCTYPE html>
<html lang="es"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Certificado · ${this.esc(opts.serialNumber)}</title>
<style>
  @page { size: A4 landscape; margin: 0; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: 'Georgia', 'Times New Roman', serif; background: #f1f5f9; }
  .cert { width: 1040px; max-width: 100%; margin: 24px auto; background: #fff;
    border: 14px solid #0f172a; border-radius: 8px; padding: 56px 64px;
    box-shadow: 0 10px 30px rgba(0,0,0,0.12); position: relative; }
  .cert::after { content: ''; position: absolute; inset: 14px; border: 2px solid #c8a23a; border-radius: 4px; pointer-events: none; }
  .brand { text-align: center; letter-spacing: 4px; color: #0f172a; font-size: 18px; font-weight: bold; text-transform: uppercase; }
  .brand small { display:block; letter-spacing: 2px; color:#c8a23a; font-size: 11px; margin-top: 4px; }
  h1 { text-align: center; font-size: 40px; color: #0f172a; margin: 28px 0 4px; }
  .subtitle { text-align: center; color: #64748b; font-size: 14px; margin-bottom: 28px; }
  .name { text-align: center; font-size: 34px; color: #c8a23a; font-weight: bold; margin: 18px 0 6px; }
  .for { text-align: center; color: #334155; font-size: 16px; }
  .course { text-align: center; font-size: 22px; color: #0f172a; font-weight: bold; margin: 8px 0 18px; }
  .score { text-align: center; color: #334155; font-size: 15px; }
  .tenant { text-align: center; color: #64748b; font-size: 13px; }
  .footer { display: flex; justify-content: space-between; align-items: flex-end; margin-top: 44px; color: #334155; font-size: 13px; }
  .footer .serial { font-family: monospace; color: #64748b; }
  .footer .date { text-align: right; }
  .seal { text-align:center; margin-top: 8px; color:#c8a23a; font-weight:bold; letter-spacing:1px; }
</style></head>
<body>
  <div class="cert">
    <div class="brand">C-Guard Pro<small>Plataforma de Seguridad Profesional</small></div>
    <h1>Certificado de Finalización</h1>
    <div class="subtitle">Se otorga el presente reconocimiento a</div>
    <div class="name">${this.esc(opts.guardName)}</div>
    <div class="for">por haber completado satisfactoriamente el curso</div>
    <div class="course">${this.esc(opts.courseTitle)}</div>
    ${scoreLine}
    ${tenantLine}
    <div class="seal">★ C-GUARD PRO ★</div>
    <div class="footer">
      <div class="serial">Serial: ${this.esc(opts.serialNumber)}</div>
      <div class="date">Emitido el ${this.esc(dateStr)}</div>
    </div>
  </div>
</body></html>`;
  }

  /**
   * Idempotently issue a certificate for a (course, guard) pair. If one already
   * exists it is returned unchanged. Returns the certificate record.
   *
   * `db` is the Sequelize models bag; all writes are tenant-scoped.
   */
  static async issue(
    db: any,
    {
      tenantId,
      courseId,
      securityGuardId,
      guardName,
      courseTitle,
      score,
      certificateTemplate,
      tenantName,
    }: {
      tenantId: string;
      courseId: string;
      securityGuardId: string;
      guardName: string;
      courseTitle: string;
      score?: number | null;
      certificateTemplate?: string | null;
      tenantName?: string | null;
    },
  ) {
    const existing = await db.trainingCertificate.findOne({
      where: { tenantId, courseId, securityGuardId, deletedAt: null },
    });
    if (existing) return existing;

    const issuedAt = new Date();
    const serialNumber = this.generateSerial();

    // Create first to obtain the id, then fill token/url/html.
    const cert = await db.trainingCertificate.create({
      tenantId,
      courseId,
      securityGuardId,
      serialNumber,
      guardName,
      courseTitle,
      score: score != null ? Math.round(Number(score)) : null,
      issuedAt,
    });

    const downloadToken = this.generateDownloadToken(cert.id, tenantId);
    const publicUrl = this.publicUrlFor(downloadToken);
    const htmlContent = this.renderHtml({
      guardName,
      courseTitle,
      score: score != null ? Math.round(Number(score)) : null,
      serialNumber,
      issuedAt,
      tenantName,
      publicUrl,
      template: certificateTemplate || null,
    });

    await cert.update({ downloadToken, publicUrl, htmlContent });
    return cert;
  }
}
