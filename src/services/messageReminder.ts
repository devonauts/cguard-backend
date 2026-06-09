/**
 * "Unread message" email reminder. Sweeps message receipts that are still unread
 * 5 minutes after the message was sent and emails the recipient — at most once
 * per receipt (claimed via reminderSentAt). Runs from a single always-on process
 * so emails are never duplicated. Best-effort; never throws.
 *
 * sendMail throws when no mail transport is configured, so this naturally only
 * emails when email is actually set up.
 */
import { Op } from 'sequelize';

const REMIND_AFTER_MS = 5 * 60 * 1000; // 5 minutes

export async function runMessageReminderSweep(db: any): Promise<number> {
  let sent = 0;
  try {
    const cutoff = new Date(Date.now() - REMIND_AFTER_MS);
    const receipts = await db.messageReceipt.findAll({
      where: {
        deliveryStatus: { [Op.ne]: 'read' },
        reminderSentAt: null,
        createdAt: { [Op.lt]: cutoff },
      },
      limit: 200,
    });

    for (const r of receipts) {
      try {
        // Claim it first so we email at most once even if the send fails / no
        // transport is configured (avoids a retry storm).
        await r.update({ reminderSentAt: new Date() });

        const recipient = await db.user.findByPk(r.recipientUserId, { attributes: ['email', 'fullName', 'firstName'] });
        const email = recipient && recipient.email;
        if (!email) continue;

        const message = await db.message.findByPk(r.messageId, { attributes: ['body', 'senderUserId', 'senderType'] });
        if (!message) continue;

        let senderName = 'Alguien';
        try {
          const s = await db.user.findByPk(message.senderUserId, { attributes: ['fullName', 'firstName'] });
          senderName = (s && (s.fullName || s.firstName)) || senderName;
        } catch { /* ignore */ }

        const preview = String(message.body || '').slice(0, 280).replace(/</g, '&lt;');
        // Recipient is staff when the sender is a guard/client → link to the CRM.
        const link = message.senderType !== 'staff' ? 'https://app.cguardpro.com/messenger' : 'https://app.cguardpro.com';
        const subject = `Mensaje sin leer de ${senderName}`;
        const html =
          `<p style="font-size:15px">${senderName} te envió un mensaje en CGuardPro que aún no has leído:</p>` +
          `<blockquote style="margin:12px 0;padding:8px 12px;border-left:3px solid #C8860A;color:#374151">${preview}</blockquote>` +
          `<p><a href="${link}" style="color:#C8860A">Ábrelo para leerlo y responder</a></p>` +
          `<p style="color:#6b7280;font-size:12px;margin-top:12px">CGuardPro</p>`;
        const text = `${senderName} te envió un mensaje en CGuardPro que aún no has leído: "${preview}". Ábrelo en ${link}`;

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { sendMail } = require('./mailService');
        await sendMail({ to: email, subject, html, text });
        sent += 1;
      } catch (e: any) {
        console.warn('[message-reminder] one failed:', e?.message || e);
      }
    }
  } catch (e: any) {
    console.warn('[message-reminder] sweep failed:', e?.message || e);
  }
  return sent;
}
