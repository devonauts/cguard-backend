import sgMail from '@sendgrid/mail';
import nodemailer from 'nodemailer';
import fs from 'fs';

const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;
const MAIL_SERVER = process.env.MAIL_SERVER;
const MAIL_PORT = process.env.MAIL_PORT ? Number(process.env.MAIL_PORT) : undefined;
const MAIL_USERNAME = process.env.MAIL_USERNAME;
const MAIL_PASSWORD = process.env.MAIL_PASSWORD;
const MAIL_DEFAULT_SENDER = process.env.MAIL_DEFAULT_SENDER || 'no-reply@example.com';
const MAIL_DEFAULT_SENDER_NAME = process.env.MAIL_DEFAULT_SENDER_NAME || '';

type Attachment = {
  filename?: string;
  path?: string;
  content?: string | Buffer;
  cid?: string;
  type?: string;
};

type MailOpts = {
  to: string | string[];
  subject: string;
  text?: string;
  html?: string;
  from?: string;
  attachments?: Attachment[];
};

let useSendgrid = false;
if (SENDGRID_API_KEY) {
  try {
    sgMail.setApiKey(SENDGRID_API_KEY);
    useSendgrid = true;
  } catch (e) {
    console.error('Failed to init SendGrid:', e);
    useSendgrid = false;
  }
}

let smtpTransport: nodemailer.Transporter | null = null;
if (!useSendgrid && MAIL_SERVER) {
  smtpTransport = nodemailer.createTransport({
    host: MAIL_SERVER,
    port: MAIL_PORT || 587,
    secure: !!(process.env.MAIL_USE_SSL === 'True' || process.env.MAIL_USE_SSL === 'true' || MAIL_PORT === 465),
    auth: MAIL_USERNAME && MAIL_PASSWORD ? { user: MAIL_USERNAME, pass: MAIL_PASSWORD } : undefined,
  });
}

export async function sendMail(opts: MailOpts) {
  const from = opts.from || (MAIL_DEFAULT_SENDER_NAME ? `${MAIL_DEFAULT_SENDER_NAME} <${MAIL_DEFAULT_SENDER}>` : MAIL_DEFAULT_SENDER);

  if (useSendgrid) {
    const msg: any = {
      to: opts.to,
      from,
      subject: opts.subject,
    };
    if (opts.html) msg.html = opts.html;
    if (opts.text) msg.text = opts.text;
    if (opts.attachments && opts.attachments.length) {
      const sgAttachments: any[] = [];
      for (const a of opts.attachments) {
        if (a.path) {
          try {
            const content = fs.readFileSync(a.path);
            sgAttachments.push({
              content: content.toString('base64'),
              filename: a.filename || (a.path && a.path.split(/[\\/]/).pop()),
              type: a.type,
              disposition: a.cid ? 'inline' : 'attachment',
              content_id: a.cid,
            });
          } catch (err) {
            console.error('Failed to read attachment path for SendGrid:', a.path, err);
          }
        } else if (a.content) {
          const buf = Buffer.isBuffer(a.content) ? a.content : Buffer.from(String(a.content));
          sgAttachments.push({
            content: buf.toString('base64'),
            filename: a.filename || 'attachment',
            type: a.type,
            disposition: a.cid ? 'inline' : 'attachment',
            content_id: a.cid,
          });
        }
      }
      if (sgAttachments.length) msg.attachments = sgAttachments;
    }
    try {
      const res = await sgMail.send(msg);
      return res;
    } catch (err) {
      console.error('SendGrid send error', err);
      throw err;
    }
  }

  if (smtpTransport) {
    try {
      const mailOptions: any = { from, to: opts.to, subject: opts.subject, text: opts.text, html: opts.html };
      if (opts.attachments) {
        mailOptions.attachments = opts.attachments.map(a => ({ filename: a.filename, path: a.path, content: a.content, cid: a.cid }));
      }
      const res = await smtpTransport.sendMail(mailOptions);
      return res;
    } catch (err) {
      console.error('SMTP send error', err);
      throw err;
    }
  }

  throw new Error('No mail transport configured. Set SENDGRID_API_KEY or MAIL_SERVER in environment.');
}

export default { sendMail };
