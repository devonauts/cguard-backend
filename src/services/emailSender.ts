import assert from 'assert';
import { getConfig } from '../config';
import sendgridMail from '@sendgrid/mail';
import mailService from './mailService';
import fs from 'fs';
import path from 'path';

if (getConfig().SENDGRID_KEY) {
  sendgridMail.setApiKey(getConfig().SENDGRID_KEY);
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
        getConfig().SENDGRID_KEY,
    );
  }

  static get TEMPLATES() {
    if (!EmailSender.isConfigured) {
      return {};
    }

    return {
      EMAIL_ADDRESS_VERIFICATION: getConfig()
        .SENDGRID_TEMPLATE_EMAIL_ADDRESS_VERIFICATION,
      INVITATION: getConfig().SENDGRID_TEMPLATE_INVITATION,
      PASSWORD_RESET: getConfig()
        .SENDGRID_TEMPLATE_PASSWORD_RESET,
    };
  }

  async sendTo(recipient: string) {
    if (!EmailSender.isConfigured) {
      console.error(`Email provider is not configured.`);
      return;
    }

    assert(recipient, 'to is required');
    assert(
      getConfig().SENDGRID_EMAIL_FROM,
      'SENDGRID_EMAIL_FROM is required',
    );

    // If a templateId is provided, use SendGrid templated send
    if (this.templateId) {
      const msg = {
        to: recipient,
        from: getConfig().SENDGRID_EMAIL_FROM,
        templateId: this.templateId,
        dynamicTemplateData: this.variables,
      };

      try {
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
      
      if (this.variables && this.variables.link) {
        // Attempt to load email-templates/passwordReset.html
        const templatePath = path.resolve(process.cwd(), 'e:\\cguard\\cguard-backend\\email-templates\\passwordReset.html');
        let htmlTemplate: string | null = null;
        try {
          htmlTemplate = await fs.promises.readFile(templatePath, 'utf-8');
        } catch (e) {
          // try relative path from src
          const altPath = path.resolve(__dirname, '..', '..', 'email-templates', 'passwordReset.html');
          try {
            htmlTemplate = await fs.promises.readFile(altPath, 'utf-8');
          } catch (e2) {
            htmlTemplate = null;
          }
        }

        subject = 'Reset your password';
        if (htmlTemplate) {
          const logoUrl = (getConfig().EMAIL_LOGO_URL) || '';
          let rendered = htmlTemplate;

          const attachments: any[] = [];
          if (logoUrl) {
            // use configured absolute URL
            rendered = rendered.replace(/{{logoUrl}}/g, logoUrl);
          } else {
            // Use local asset as inline cid attachment to keep HTML small (avoids base64 inline)
            const localLogoPath = path.resolve(process.cwd(), 'e:\\cguard\\cguard-backend\\assets\\logo.png');
            try {
              const exists = await fs.promises.access(localLogoPath).then(() => true).catch(() => false);
              if (exists) {
                const cid = 'logo@cguard';
                rendered = rendered.replace(/{{logoUrl}}/g, `cid:${cid}`);
                attachments.push({ filename: 'logo.png', path: localLogoPath, cid });
              } else {
                // remove logo block to avoid broken image icons
                rendered = rendered.replace(/<div class="logo">[\s\S]*?<\/div>/, '');
              }
            } catch (e) {
              rendered = rendered.replace(/<div class="logo">[\s\S]*?<\/div>/, '');
            }
          }

          const html = rendered.replace(/{{link}}/g, this.variables.link);
          return await mailService.sendMail({ to: recipient, subject, html, from: getConfig().SENDGRID_EMAIL_FROM, attachments: attachments.length ? attachments : undefined });
        }

        // fallback simple HTML if template not found
        const text = `Please follow this link: ${this.variables.link}`;
        const html = `<p>Please follow this link: <a href="${this.variables.link}">${this.variables.link}</a></p>`;
        return await mailService.sendMail({ to: recipient, subject, text, html, from: getConfig().SENDGRID_EMAIL_FROM });
      }

      // Generic variables rendering
      const text = JSON.stringify(this.variables || {});
      const html = `<pre>${JSON.stringify(this.variables || {}, null, 2)}</pre>`;
      return await mailService.sendMail({ to: recipient, subject, text, html, from: getConfig().SENDGRID_EMAIL_FROM });
    } catch (err) {
      console.error('Fallback mail send error', err);
      throw err;
    }
  }

}
