import assert from 'assert';
import { getConfig } from '../config';
import sendgridMail from '@sendgrid/mail';
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
      const msg = {
        to: recipient,
        from: getConfig().SENDGRID_EMAIL_FROM,
        templateId: this.templateId,
        dynamicTemplateData: this.variables,
      };

      try {
        console.info('[EmailSender] Using SendGrid template send', { to: recipient, templateId: this.templateId });
        return await sendgridMail.send(msg);
      } catch (error) {
        console.error('Error sending SendGrid email.');
        console.error(error);
        throw error;
      }
    }

    // Fallback: if no templateId available, attempt to use local HTML templates
    try {
      let subject = 'Notification from application';

      // Decide which local template to use based on variables
      const chooseTemplate = () => {
        // Invitation: variables.guard present or explicit 'invitation' flag
        // Also consider common resend case where callers pass { tenant, link } without a guard
        if (this.variables && (this.variables.guard || this.variables.invitation || (this.variables.tenant && this.variables.link))) {
          return 'invitation.html';
        }

        // Email address verification: may be expressed as emailVerificationToken
        if (this.variables && (this.variables.emailVerificationToken || (this.variables.guard && this.variables.guard.emailVerificationToken))) {
          return 'emailAddressVerification.html';
        }

        // Password reset fallback
        if (this.variables && this.variables.link) {
          return 'passwordReset.html';
        }

        // Default
        return null;
      };

      const templateFile = chooseTemplate();
      console.info('[EmailSender] Fallback chosen template', { templateFile });
      if (templateFile) {
        // Attempt several paths: absolute workspace path or relative src path
        const absolutePath = path.resolve(process.cwd(), 'e:\\cguard\\cguard-backend\\email-templates\\' + templateFile);
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
        if (templateFile === 'invitation.html') subject = 'Invitación al sistema';
        else if (templateFile === 'emailAddressVerification.html') subject = 'Verifique su dirección de correo';
        else if (templateFile === 'passwordReset.html') subject = 'Reset your password';

        if (htmlTemplate) {
          console.info('[EmailSender] Loaded local template file', { path: absolutePath, altPath });
          const logoUrl = (getConfig().EMAIL_LOGO_URL) || '';
          let rendered = htmlTemplate;

          const attachments: any[] = [];
          if (logoUrl) {
            rendered = rendered.replace(/{{logoUrl}}/g, logoUrl);
          } else {
            const localLogoPath = path.resolve(process.cwd(), 'e:\\cguard\\cguard-backend\\assets\\logo.png');
            try {
              const exists = await fs.promises.access(localLogoPath).then(() => true).catch(() => false);
              if (exists) {
                const cid = 'logo@cguard';
                rendered = rendered.replace(/{{logoUrl}}/g, `cid:${cid}`);
                attachments.push({ filename: 'logo.png', path: localLogoPath, cid });
              } else {
                rendered = rendered.replace(/<div class="logo">[\s\S]*?<\/div>/, '');
              }
            } catch (e) {
              rendered = rendered.replace(/<div class="logo">[\s\S]*?<\/div>/, '');
            }
          }

          // Replace common placeholders
          if (this.variables && this.variables.link) {
            rendered = rendered.replace(/{{link}}/g, this.variables.link);
          }

          // Support guard object or top-level firstName/lastName
          const firstName = (this.variables && (this.variables.guard && this.variables.guard.firstName)) || (this.variables && this.variables.firstName) || '';
          const lastName = (this.variables && (this.variables.guard && this.variables.guard.lastName)) || (this.variables && this.variables.lastName) || '';
          const emailVar = (this.variables && (this.variables.guard && this.variables.guard.email)) || (this.variables && this.variables.email) || '';

          rendered = rendered.replace(/{{firstName}}/g, firstName);
          rendered = rendered.replace(/{{lastName}}/g, lastName);
          rendered = rendered.replace(/{{email}}/g, emailVar);

          // Tenant name replacements (template uses {{tenant.name}})
          const tenantName = (this.variables && this.variables.tenant && (this.variables.tenant.name || this.variables.tenant.displayName)) || '';
          if (tenantName) {
            rendered = rendered.replace(/{{tenant\.name}}/g, tenantName);
            rendered = rendered.replace(/{{tenantName}}/g, tenantName);
          }

          const result = await mailService.sendMail({ to: recipient, subject, html: rendered, from: getConfig().SENDGRID_EMAIL_FROM, attachments: attachments.length ? attachments : undefined });
          console.info('[EmailSender] mailService.sendMail result', { to: recipient, subject, success: true });
          return result;
        }

        // Fallback simple link if template missing
        if (this.variables && this.variables.link) {
          const text = `Please follow this link: ${this.variables.link}`;
          const html = `<p>Please follow this link: <a href="${this.variables.link}">${this.variables.link}</a></p>`;
          const result = await mailService.sendMail({ to: recipient, subject, text, html, from: getConfig().SENDGRID_EMAIL_FROM });
          console.info('[EmailSender] mailService.sendMail (simple link) result', { to: recipient, subject, success: true });
          return result;
        }
      }

      // Generic variables rendering
      const text = JSON.stringify(this.variables || {});
      const html = `<pre>${JSON.stringify(this.variables || {}, null, 2)}</pre>`;
      const result = await mailService.sendMail({ to: recipient, subject, text, html, from: getConfig().SENDGRID_EMAIL_FROM });
      console.info('[EmailSender] mailService.sendMail (generic) result', { to: recipient, subject, success: true });
      return result;
    } catch (err) {
      console.error('Fallback mail send error', err);
      throw err;
    }
  }

}
