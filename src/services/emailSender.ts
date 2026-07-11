import assert from 'assert';
import { getConfig } from '../config';
import sendgridMail from '@sendgrid/mail';
import { auditEmail, messageIdFromSendgridResponse } from '../lib/emailAudit';
import mailService from './mailService';
import fs from 'fs';
import path from 'path';

if (getConfig().SENDGRID_API_KEY) {
  sendgridMail.setApiKey(getConfig().SENDGRID_API_KEY);
}

export default class EmailSender {
  templateId: string;
  variables: any;

  constructor(templateId: string, variables: any) {
    this.templateId = templateId;
    this.variables = variables;
  }

  static get isConfigured(): boolean {
    return Boolean(
      getConfig().SENDGRID_EMAIL_FROM &&
        getConfig().SENDGRID_API_KEY,
    );
  }

  static get TEMPLATES() {
    if (!EmailSender.isConfigured) {
      return {};
    }

    return {
      EMAIL_ADDRESS_VERIFICATION: getConfig().SENDGRID_TEMPLATE_EMAIL_ADDRESS_VERIFICATION,
      INVITATION: getConfig().SENDGRID_TEMPLATE_INVITATION,
      PASSWORD_RESET: getConfig().SENDGRID_TEMPLATE_PASSWORD_RESET,
    };
  }

  async sendTo(recipient: string) {
    assert(recipient, 'to is required');
    console.info('[EmailSender] sendTo called', { to: recipient, isConfigured: EmailSender.isConfigured, templateId: this.templateId ? '<provided>' : '<none>' });
    // Require SENDGRID_EMAIL_FROM only when SendGrid is configured; otherwise mailService will use its default sender
    if (EmailSender.isConfigured) {
      assert(
        getConfig().SENDGRID_EMAIL_FROM,
        'SENDGRID_EMAIL_FROM is required when using SendGrid',
      );
    }

    // If a templateId is provided, use SendGrid templated send
    if (this.templateId) {
      // Aggressive mitigation: if caller requests the PASSWORD_RESET template
      // but an invitation was sent very recently to this recipient, skip it.
      try {
        if (!(EmailSender as any)._recentSends) {
          (EmailSender as any)._recentSends = new Map();
        }
        const recentSends: Map<string, { template?: string; ts: number }> = (EmailSender as any)._recentSends;
        const last = recentSends.get(recipient);
        // If an invitation was sent very recently, skip password reset or
        // email address verification sends to avoid duplicate emails.
        if (last && last.template === 'invitation' && Date.now() - last.ts < 10000) {
          if (this.templateId === EmailSender.TEMPLATES.PASSWORD_RESET || this.templateId === EmailSender.TEMPLATES.EMAIL_ADDRESS_VERIFICATION) {
            console.warn('[EmailSender] Skipping SendGrid verification/password send because recent invitation was sent', { to: recipient });
            auditEmail('email.skipped', { to: recipient, reason: 'recent invitation already sent', transport: 'sendgrid-template' });
            return { skippedDuplicate: true };
          }
        }
      } catch (e) {
        // ignore
      }
      const msg = {
        to: recipient,
        from: getConfig().SENDGRID_EMAIL_FROM,
        templateId: this.templateId,
        dynamicTemplateData: this.variables,
      };

      try {
        console.info('[EmailSender] Using SendGrid template send', { to: recipient, templateId: this.templateId });
        const res = await sendgridMail.send(msg);
        auditEmail('email.sent', {
          to: recipient,
          subject: `template:${this.templateId}`,
          transport: 'sendgrid-template',
          messageId: messageIdFromSendgridResponse(res),
        });
        try {
          const recentSends: Map<string, { template?: string; ts: number }> = (EmailSender as any)._recentSends || new Map();
          const tName = this.templateId === EmailSender.TEMPLATES.INVITATION ? 'invitation' : (this.templateId === EmailSender.TEMPLATES.EMAIL_ADDRESS_VERIFICATION ? 'verification' : 'other');
          recentSends.set(recipient, { template: tName, ts: Date.now() });
          (EmailSender as any)._recentSends = recentSends;
          setTimeout(() => recentSends.delete(recipient), 15000);
        } catch (e) {
          // ignore
        }
        return res;
      } catch (error) {
        console.error('Error sending SendGrid email.');
        console.error(error);
        auditEmail('email.send_failed', {
          to: recipient,
          subject: `template:${this.templateId}`,
          transport: 'sendgrid-template',
          error: (error as any)?.message || String(error),
        });
        throw error;
      }
    }

    // Fallback: if no templateId available, attempt to use local HTML templates
    try {
      // Diagnostic: capture caller stack and variables to help root-cause duplicate sends
      try {
        const st = new Error().stack;
        console.debug('[EmailSender] Fallback send stack trace', { to: recipient, variables: this.variables, stack: st });
      } catch (e) {
        // ignore logging errors
      }
      let subject = 'Notification from application';

      // Decide which local template to use based on variables.
      // Broaden detection to accept multiple possible keys used by various callers
      // so the correct HTML template is chosen instead of falling back to a generic JSON message.
      const chooseTemplate = () => {
        if (!this.variables) return null;

        const v = this.variables;

        // Normalize some common keys across callers
        const has = (keys: string[]) => keys.some((k) => typeof v[k] !== 'undefined' && v[k] !== null);

        // App invitation — "download & use Mi Seguridad" template
        if (has(['appInvite'])) {
          return 'invitation-app.html';
        }

        // Client portal invitation — use dedicated Mi Seguridad welcome template
        if (has(['clientInvitation'])) {
          return 'invitation-client.html';
        }

        // Invitation signals: explicit 'invitation', 'invite', 'invitationToken', or presence of a guard object
        if (has(['invitation', 'invite', 'invitationToken', 'inviteToken']) || v.guard) {
          return 'invitation.html';
        }

        // Password reset signals: explicit 'passwordReset', 'passwordResetToken', 'resetToken'
        if (has(['passwordReset', 'passwordResetToken', 'resetToken'])) {
          return 'passwordReset.html';
        }

        // Email verification signals: explicit flags or tokens
        if (has(['emailVerification', 'emailVerificationToken', 'verifyEmailToken', 'verificationToken'])) {
          return 'emailAddressVerification.html';
        }

        // If caller provided a 'type' or 'template' hint, accept common values
        if (typeof v.type === 'string') {
          const t = (v.type || '').toLowerCase();
          if (t.includes('invite') || t.includes('invitation')) return 'invitation.html';
          if (t.includes('password') || t.includes('reset')) return 'passwordReset.html';
          if (t.includes('verify') || t.includes('verification') || t.includes('email')) return 'emailAddressVerification.html';
          if (t.includes('invoice')) return 'invoice.html';
          if (t.includes('estimate') || t.includes('quote') || t.includes('presupuesto')) return 'estimate.html';
        }

        if (typeof v.template === 'string') {
          const t = (v.template || '').toLowerCase();
          if (t.includes('invite')) return 'invitation.html';
          if (t.includes('password')) return 'passwordReset.html';
          if (t.includes('verify') || t.includes('email')) return 'emailAddressVerification.html';
          if (t.includes('invoice')) return 'invoice.html';
          if (t.includes('estimate') || t.includes('quote') || t.includes('presupuesto')) return 'estimate.html';
        }

        // If caller only provided a `link` and no other indicators, prefer email verification UX
        if (v.link && !has(['invitation', 'passwordReset'])) {
          return 'emailAddressVerification.html';
        }

        return null;
      };

      let templateFile = chooseTemplate();
      // Force app-invitation template when flag is set
      if (this.variables && this.variables.appInvite) {
        templateFile = 'invitation-app.html';
      } else if (this.variables && this.variables.clientInvitation) {
        // Force client welcome template when flag is set
        templateFile = 'invitation-client.html';
      } else if (this.variables && (this.variables.invitation || this.variables.guard)) {
        // Force guard/staff invitation template
        templateFile = 'invitation.html';
      }
      console.info('[EmailSender] Fallback chosen template', { templateFile, to: recipient, variables: this.variables });
      if (templateFile) {
        // Attempt several paths: absolute workspace path or relative src path
        const absolutePath = path.resolve(process.cwd(), 'email-templates', templateFile);
        const altPath = path.resolve(__dirname, '..', '..', 'email-templates', templateFile);

        let htmlTemplate: string | null = null;
        try {
          htmlTemplate = await fs.promises.readFile(absolutePath, 'utf-8');
        } catch (e) {
          try {
            htmlTemplate = await fs.promises.readFile(altPath, 'utf-8');
          } catch (e2) {
            htmlTemplate = null;
          }
        }

        // Determine subject default per template
        if (templateFile === 'invitation-app.html') {
          const tName = (this.variables && this.variables.tenant && (this.variables.tenant.name || this.variables.tenant.displayName)) || '';
          subject = tName ? `Descarga Mi Seguridad — ${tName}` : 'Descarga la app Mi Seguridad';
        } else if (templateFile === 'invitation-client.html') {
          const tName = (this.variables && this.variables.tenant && (this.variables.tenant.name || this.variables.tenant.displayName)) || '';
          subject = tName ? `¡Te damos la bienvenida a ${tName}!` : '¡Te damos la bienvenida!';
        } else if (templateFile === 'invitation.html') {
          const tName = (this.variables && this.variables.tenant && (this.variables.tenant.name || this.variables.tenant.displayName)) || '';
          subject = tName ? `Invitación de ${tName}` : 'Invitación al sistema';
        } else if (templateFile === 'emailAddressVerification.html') {
          const tName = (this.variables && this.variables.tenant && (this.variables.tenant.name || this.variables.tenant.displayName)) || '';
          subject = tName ? `${tName} — Verifica tu correo electrónico` : 'Verifique su dirección de correo';
        } else if (templateFile === 'passwordReset.html') {
          const tName = (this.variables && this.variables.tenant && (this.variables.tenant.name || this.variables.tenant.displayName)) || '';
          subject = tName ? `${tName} — Restablecer contraseña` : 'Restablecer contraseña';
        }

        if (htmlTemplate) {
          console.info('[EmailSender] Loaded local template file', { path: absolutePath, altPath });
          if (templateFile === 'passwordReset.html') {
            console.warn('[EmailSender] Sending passwordReset.html via fallback', { to: recipient, variables: this.variables });
          }
          // Resolve tenant logo — prefer the tenant's own uploaded logo
          const tenantObj = this.variables?.tenant;
          const tenantSettings = tenantObj?.settings || tenantObj?.dataValues?.settings;
          const tenantSettingsData = (tenantSettings && typeof tenantSettings.get === 'function') ? tenantSettings.get({ plain: true }) : tenantSettings;
          // Try all possible locations: file association publicUrl/privateUrl, direct logoUrl field, settings, env
          let tenantLogoUrl =
            (tenantObj?.logo?.publicUrl) ||
            (tenantObj?.logoUrl) ||
            (tenantSettingsData?.logoUrl) ||
            '';
          // This is a TENANT email — show the tenant's OWN logo, never the
          // platform logo. If the caller didn't include the tenant's logo,
          // look it up by tenantId (the /api/file/download URL is public, so it
          // loads in email clients). No EMAIL_LOGO_URL fallback on purpose.
          if (!tenantLogoUrl && tenantObj?.id) {
            try {
              const dbModels = require('../database/models').default;
              const db = dbModels();
              const s = await db.settings.findOne({ where: { tenantId: tenantObj.id } });
              if (s && (s.logoUrl || s.get?.('logoUrl'))) {
                tenantLogoUrl = s.logoUrl || s.get('logoUrl');
              }
            } catch (e) {
              console.warn('[EmailSender] tenant logo lookup failed', (e as any)?.message || e);
            }
          }
          const tenantName = (tenantObj && (tenantObj.name || tenantObj.displayName)) || '';
          let rendered = htmlTemplate;

          const attachments: any[] = [];
          if (tenantLogoUrl) {
            rendered = rendered.replace(/{{logoUrl}}/g, tenantLogoUrl);
          } else {
            // No tenant logo available — hide the img tag entirely (tenant name text is already in template)
            rendered = rendered.replace(/<img[^>]*\{\{logoUrl\}\}[^>]*\/?\s*>/g, '');
          }

          // Mi Seguridad app logo — use public hosted URL (Gmail blocks base64 inline images)
          const miSeguridadPublicUrl = `${(getConfig().FRONTEND_URL || 'https://app.cguardpro.com').replace(/\/+$/, '')}/assets/logo/miseguridad.png`;
          rendered = rendered.replace(/{{miSeguridadLogoUrl}}/g, miSeguridadPublicUrl);

          // Per-tenant brand colors — recolor the account templates the same way
          // the notification shell is branded (Preferencias de Correo). The
          // hardcoded accent (#C8860A) and header navy (#0A0E16) become the
          // tenant's chosen colors; both DEFAULT to those exact hexes, so this
          // is a no-op until a tenant customizes. Best-effort — never blocks send.
          if (tenantObj?.id) {
            try {
              // eslint-disable-next-line @typescript-eslint/no-var-requires
              const { getEmailBranding } = require('../lib/emailLayout');
              // eslint-disable-next-line @typescript-eslint/no-var-requires
              const db = require('../database/models').default();
              const brand = await getEmailBranding(db, tenantObj.id);
              if (brand?.brandColor && brand.brandColor.toUpperCase() !== '#C8860A') {
                rendered = rendered.replace(/#C8860A/gi, brand.brandColor);
              }
              if (brand?.headerColor && brand.headerColor.toUpperCase() !== '#0A0E16') {
                rendered = rendered.replace(/#0A0E16/gi, brand.headerColor);
              }
            } catch (e) {
              console.warn('[EmailSender] brand color apply failed', (e as any)?.message || e);
            }
          }

          // Replace common placeholders
          if (this.variables) {
            const renderedLink = this.variables.link || this.variables.invitationLink || this.variables.inviteLink || this.variables.registrationLink || this.variables.verifyLink || this.variables.verificationLink || '';
            rendered = rendered.replace(/{{link}}/g, renderedLink);
            rendered = rendered.replace(/{{invitationLink}}/g, renderedLink);
            rendered = rendered.replace(/{{inviteLink}}/g, renderedLink);
            rendered = rendered.replace(/{{registrationLink}}/g, renderedLink);
            rendered = rendered.replace(/{{verifyLink}}/g, renderedLink);
            rendered = rendered.replace(/{{verificationLink}}/g, renderedLink);
          }

          // Support guard object or top-level firstName/lastName
          const firstName = (this.variables && (this.variables.guard && this.variables.guard.firstName)) || (this.variables && this.variables.firstName) || '';
          const lastName = (this.variables && (this.variables.guard && this.variables.guard.lastName)) || (this.variables && this.variables.lastName) || '';
          const emailVar = (this.variables && (this.variables.guard && this.variables.guard.email)) || (this.variables && this.variables.email) || '';

          rendered = rendered.replace(/{{firstName}}/g, firstName);
          rendered = rendered.replace(/{{lastName}}/g, lastName);
          rendered = rendered.replace(/{{email}}/g, emailVar);

          // Tenant name replacements (template uses {{tenant.name}}) — use tenantName already declared above
          // Always replace placeholders to avoid leaking template markers when value missing
          rendered = rendered.replace(/{{tenant\.name}}/g, tenantName);
          rendered = rendered.replace(/{{tenantName}}/g, tenantName);

          // Support email
          const supportEmail = (getConfig() as any).SUPPORT_EMAIL || (getConfig() as any).SENDGRID_EMAIL_FROM || '';
          rendered = rendered.replace(/{{supportEmail}}/g, supportEmail);

          // Deduplicate quick repeated sends: skip if same recipient+subject sent within the last few seconds
          try {
            const key = `${recipient}::${subject}`;
            const now = Date.now();
            if (!(EmailSender as any)._recentSends) {
              (EmailSender as any)._recentSends = new Map();
            }
            const recentSends: Map<string, number> = (EmailSender as any)._recentSends;
            const last = recentSends.get(key) || 0;
            if (now - last < 3000) {
              console.warn('[EmailSender] Skipping duplicate email send (dedupe)', { to: recipient, subject, sinceMs: now - last });
              auditEmail('email.skipped', { to: recipient, subject, reason: `dedupe (${now - last}ms since last send)` });
              return { skippedDuplicate: true };
            }
            recentSends.set(key, now);
            // cleanup entry after 10s
            setTimeout(() => recentSends.delete(key), 10000);
          } catch (e) {
            // ignore dedupe errors
          }

          // Additional aggressive mitigation: if this fallback would send a password reset
          // but an invitation was sent recently to the same recipient, skip password reset.
          try {
            const recentTemplateMap: Map<string, { template?: string; ts: number }> = (EmailSender as any)._recentSends || new Map();
            const last = recentTemplateMap.get(recipient);
            if (last && last.template === 'invitation' && Date.now() - last.ts < 10000) {
              if (templateFile === 'passwordReset.html' || templateFile === 'emailAddressVerification.html') {
                console.warn('[EmailSender] Skipping fallback verification/password because recent invitation was sent', { to: recipient });
                auditEmail('email.skipped', { to: recipient, reason: 'recent invitation already sent' });
                return { skippedDuplicate: true };
              }
            }
            // mark this send as invitation or other for receiver-level dedupe
            try {
              const recentSends: Map<string, { template?: string; ts: number }> = (EmailSender as any)._recentSends || new Map();
              recentSends.set(recipient, { template: templateFile === 'invitation.html' ? 'invitation' : 'other', ts: Date.now() });
              (EmailSender as any)._recentSends = recentSends;
              setTimeout(() => recentSends.delete(recipient), 15000);
            } catch (e) {
              // ignore
            }
          } catch (e) {
            // ignore
          }

          try {
            // Build per-tenant sender display name so recipients see e.g. "Ecuaseguridad Team" not the platform name
            const baseFromEmail = getConfig().SENDGRID_EMAIL_FROM || '';
            const fromDisplayName = tenantName ? `${tenantName} Team` : '';
            const fromField = fromDisplayName && baseFromEmail ? `${fromDisplayName} <${baseFromEmail}>` : (baseFromEmail || undefined);
            const result = await mailService.sendMail({ to: recipient, subject, html: rendered, from: fromField, attachments: attachments.length ? attachments : undefined });
            console.info('[EmailSender] mailService.sendMail result', { to: recipient, subject, success: true });
            return result;
          } catch (err) {
            console.warn('[EmailSender] mailService.sendMail failed; saving rendered email to disk', { to: recipient, err: err && (err as any).message });
            try {
              const outDir = path.resolve(process.cwd(), 'tmp_emails');
              await fs.promises.mkdir(outDir, { recursive: true });
              const safe = String(recipient).replace(/[^a-z0-9@.]/gi, '_');
              const fileName = `${Date.now()}-${safe}.html`;
              const outPath = path.join(outDir, fileName);
              await fs.promises.writeFile(outPath, rendered, 'utf8');
              console.info('[EmailSender] Saved rendered email to disk', { path: outPath });
              return { savedToDisk: outPath };
            } catch (e2) {
              console.error('[EmailSender] Failed to save rendered email to disk', e2);
              throw err;
            }
          }
        }

        // Fallback simple link if template missing
        if (this.variables && this.variables.link) {
          const text = `Please follow this link: ${this.variables.link}`;
          const html = `<p>Please follow this link: <a href="${this.variables.link}">${this.variables.link}</a></p>`;
          try {
            const result = await mailService.sendMail({ to: recipient, subject, text, html, from: getConfig().SENDGRID_EMAIL_FROM });
            console.info('[EmailSender] mailService.sendMail (simple link) result', { to: recipient, subject, success: true });
            return result;
          } catch (err) {
            console.warn('[EmailSender] mailService.sendMail (simple link) failed; saving simple link email to disk', { to: recipient, err: err && (err as any).message });
            try {
              const outDir = path.resolve(process.cwd(), 'tmp_emails');
              await fs.promises.mkdir(outDir, { recursive: true });
              const safe = String(recipient).replace(/[^a-z0-9@.]/gi, '_');
              const fileName = `${Date.now()}-${safe}-link.html`;
              const outPath = path.join(outDir, fileName);
              await fs.promises.writeFile(outPath, html, 'utf8');
              console.info('[EmailSender] Saved simple link email to disk', { path: outPath });
              return { savedToDisk: outPath };
            } catch (e2) {
              console.error('[EmailSender] Failed to save simple link email to disk', e2);
              throw err;
            }
          }
        }
      }

      // Generic variables rendering
      const text = JSON.stringify(this.variables || {});
      const html = `<pre>${JSON.stringify(this.variables || {}, null, 2)}</pre>`;
      try {
        const result = await mailService.sendMail({ to: recipient, subject, text, html, from: getConfig().SENDGRID_EMAIL_FROM });
        console.info('[EmailSender] mailService.sendMail (generic) result', { to: recipient, subject, success: true });
        return result;
      } catch (err) {
        console.warn('[EmailSender] mailService.sendMail (generic) failed; saving generic email to disk', { to: recipient, err: err && (err as any).message });
        try {
          const outDir = path.resolve(process.cwd(), 'tmp_emails');
          await fs.promises.mkdir(outDir, { recursive: true });
          const safe = String(recipient).replace(/[^a-z0-9@.]/gi, '_');
          const fileName = `${Date.now()}-${safe}-generic.html`;
          const outPath = path.join(outDir, fileName);
          await fs.promises.writeFile(outPath, html, 'utf8');
          console.info('[EmailSender] Saved generic email to disk', { path: outPath });
          return { savedToDisk: outPath };
        } catch (e2) {
          console.error('[EmailSender] Failed to save generic email to disk', e2);
          throw err;
        }
      }
    } catch (err) {
      console.error('Fallback mail send error', err);
      throw err;
    }
  }

}
