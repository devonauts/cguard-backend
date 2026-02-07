/**
 * Simple KPI worker to be run periodically (cron or systemd timer).
 * Usage: node ./dist/src/tools/kpiWorker.js  OR ts-node src/tools/kpiWorker.ts
 */
import models from '../database/models';
import EmailSender from '../services/emailSender';

async function run() {
  const { sequelize } = models();
  const db = models();

  try {
    // Find active KPIs with emailNotification=true
    const kpis = await db.kpi.findAll({ where: { active: true, emailNotification: true } });

    for (const kpi of kpis) {
      try {
        const emails = Array.isArray(kpi.emails) ? kpi.emails : [];
        if (!emails.length) continue;

        // Simple email content — in real world build a proper report
        const subject = `KPI Report: ${kpi.frequency || 'periodic'}`;
        const body = `KPI Description:\n${kpi.description || ''}\n\nOptions: ${JSON.stringify(kpi.reportOptions || {})}`;

        // Using EmailSender with a basic template is optional; fall back to simple console log
        for (const to of emails) {
          try {
            if (EmailSender.isConfigured) {
              const sender = new EmailSender(EmailSender.TEMPLATES.EMAIL_ADDRESS_VERIFICATION, { subject, body });
              await sender.sendTo(to);
            } else {
              console.log(`Would send KPI email to ${to}: ${subject}\n${body}`);
            }
          } catch (e) {
            console.error('Failed to send KPI email to', to, e);
          }
        }
      } catch (e) {
        console.error('Failed to process KPI', kpi.id, e);
      }
    }
  } catch (e) {
    console.error('KPI worker failed', e);
  } finally {
    try { await sequelize.close(); } catch (e) {}
  }
}

if (require.main === module) {
  run();
}
