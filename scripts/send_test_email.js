#!/usr/bin/env node
/*
  Simple test script to send an invitation-style email using current env vars.
  Usage: node scripts/send_test_email.js recipient@example.com
*/
const sendgridMail = require('@sendgrid/mail');
const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');

async function main() {
  const to = process.argv[2] || process.env.TEST_EMAIL_TO;
  if (!to) {
    console.error('Usage: node scripts/send_test_email.js recipient@example.com');
    process.exit(2);
  }

  const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;
  const SENDGRID_EMAIL_FROM = process.env.SENDGRID_EMAIL_FROM;
  const MAIL_SERVER = process.env.MAIL_SERVER;
  const MAIL_PORT = process.env.MAIL_PORT;
  const MAIL_USERNAME = process.env.MAIL_USERNAME;
  const MAIL_PASSWORD = process.env.MAIL_PASSWORD;
  const MAIL_DEFAULT_SENDER = process.env.MAIL_DEFAULT_SENDER || 'no-reply@example.com';

  const link = process.env.TEST_LINK || 'https://example.com/auth/invitation?token=test-token';
  const tenantName = process.env.TEST_TENANT_NAME || 'MiEmpresa';
  const firstName = process.env.TEST_FIRST_NAME || 'Nombre';
  const lastName = process.env.TEST_LAST_NAME || 'Apellido';

  // Try SendGrid if key present
  if (SENDGRID_API_KEY) {
    console.log('Using SendGrid to send test email...');
    sendgridMail.setApiKey(SENDGRID_API_KEY);
    const from = SENDGRID_EMAIL_FROM || MAIL_DEFAULT_SENDER;
    const html = fs.readFileSync(path.resolve(__dirname, '..', 'email-templates', 'invitation.html'), 'utf-8')
      .replace(/{{logoUrl}}/g, process.env.EMAIL_LOGO_URL || '')
      .replace(/{{link}}/g, link)
      .replace(/{{tenant.name}}/g, tenantName)
      .replace(/{{firstName}}/g, firstName)
      .replace(/{{lastName}}/g, lastName);

    const msg = {
      to,
      from,
      subject: `Invitación - ${tenantName}`,
      html,
    };

    try {
      const res = await sendgridMail.send(msg);
      console.log('SendGrid response:', res && res.length ? res[0].statusCode : res);
      process.exit(0);
    } catch (err) {
      console.error('SendGrid send error:', err && err.response ? err.response.body : err);
      process.exit(1);
    }
  }

  // Otherwise try SMTP
  if (MAIL_SERVER) {
    console.log('Using SMTP to send test email...');
    const transporter = nodemailer.createTransport({
      host: MAIL_SERVER,
      port: MAIL_PORT ? Number(MAIL_PORT) : 587,
      secure: MAIL_PORT && Number(MAIL_PORT) === 465,
      auth: MAIL_USERNAME && MAIL_PASSWORD ? { user: MAIL_USERNAME, pass: MAIL_PASSWORD } : undefined,
    });

    const from = MAIL_DEFAULT_SENDER;
    const html = fs.readFileSync(path.resolve(__dirname, '..', 'email-templates', 'invitation.html'), 'utf-8')
      .replace(/{{logoUrl}}/g, process.env.EMAIL_LOGO_URL || '')
      .replace(/{{link}}/g, link)
      .replace(/{{tenant.name}}/g, tenantName)
      .replace(/{{firstName}}/g, firstName)
      .replace(/{{lastName}}/g, lastName);

    try {
      const info = await transporter.sendMail({ from, to, subject: `Invitación - ${tenantName}`, html });
      console.log('SMTP send info:', info);
      process.exit(0);
    } catch (err) {
      console.error('SMTP send error:', err);
      process.exit(1);
    }
  }

  console.error('No mail transport configured. Set SENDGRID_API_KEY or MAIL_SERVER env vars.');
  process.exit(2);
}

main();
