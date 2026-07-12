/**
 * NotificationDispatcher
 *
 * Single entry point for emitting platform events.
 * Called from services after successful DB commits.
 *
 * - Writes the event to the platform_events table (DB polling feeds SSE)
 * - Optionally sends an email for critical events
 *
 * Works correctly with PM2 cluster mode: since all instances share
 * the same database, SSE connections on any instance will poll and
 * receive events written by any other instance.
 */

import { storePlatformEvent } from './platformEventStore';
import { getTemplate, TARGET_ROLES } from './notificationTemplates';
import { sendMail } from '../services/mailService';
import { renderNotificationEmail, getEmailBranding } from './emailLayout';
import { sendSmsForTenant } from '../services/smsService';
import { EVENT_EMAIL_KEY } from './emailCatalog';
import { isEmailEnabled } from './emailPrefs';
import { channelsForEvent } from './notificationChannels';
import { resolveRecipients } from './notificationRecipients';

export interface DispatchOptions {
  /** The Sequelize database object (from IServiceOptions.database) */
  database: any;
  /** The tenant this event belongs to */
  tenantId: string;
  /** Specific user id to receive the event (for 'specific' target events) */
  recipientUserId?: string;
  /** The entity that triggered the event (e.g. 'incident', 'guardShift') */
  sourceEntityType?: string;
  /** The id of the triggering entity */
  sourceEntityId?: string;
  /** Email address to send notification to (for email-enabled events) */
  recipientEmail?: string;
  /** Phone number to send SMS to (for SPECIFIC events) */
  recipientPhone?: string;
  /**
   * Extra email addresses to include alongside the role-resolved recipients
   * (e.g. the client account + tenant contact for a clock-in). Only used when
   * the event's email channel is enabled.
   */
  extraEmails?: string[];
  /**
   * Narrow role-targeted recipients to users assigned to this post-site
   * (businessInfo id) — see resolveRecipients. Used by attendance exceptions
   * when "assigned supervisors only" is enabled.
   */
  assignedPostSiteId?: string;
}

/**
 * Wrap a per-event emailHtml() fragment in the tenant-branded email shell
 * (logo, brand accent color, header, footer) so every transactional email is
 * consistent + on-brand. Best-effort: any failure returns the bare fragment so
 * the email still goes out.
 */
async function brandWrapEmail(
  database: any,
  tenantId: string,
  subject: string,
  fragmentHtml: string,
): Promise<string> {
  try {
    const brand = await getEmailBranding(database, tenantId);
    return renderNotificationEmail({
      tenantName: brand.tenantName,
      logoUrl: brand.logoUrl,
      brandColor: brand.brandColor,
      headerColor: brand.headerColor,
      eyebrow: 'Notificación',
      title: subject,
      body: '',
      bodyHtml: fragmentHtml,
    });
  } catch {
    return fragmentHtml;
  }
}

/**
 * Dispatches a platform event: stores it in the DB and sends email if configured.
 *
 * @param eventType - One of the EventType strings from notificationTemplates.ts
 * @param data - Template data (guard name, site name, etc.)
 * @param opts - Dispatch options (database, tenantId, ...)
 */
export async function dispatch(
  eventType: string,
  data: Record<string, any>,
  opts: DispatchOptions,
): Promise<void> {
  try {
    const template = getTemplate(eventType);
    if (!template) {
      console.warn(`[NotificationDispatcher] No template for eventType "${eventType}"`);
      return;
    }

    const title = template.title(data);
    const body = template.body(data);
    const targetRoles =
      template.targetRoles === TARGET_ROLES.SPECIFIC ? null : template.targetRoles;
    const recipientUserId =
      template.targetRoles === TARGET_ROLES.SPECIFIC
        ? (opts.recipientUserId || null)
        : null;

    // Per-tenant channel preferences (Configuración → Notificaciones).
    // Mapped events are governed by the matrix; unmapped events keep the legacy
    // behaviour (always-in-app + Preferencias-de-correo-gated email).
    const { rowId, prefs } = await channelsForEvent(opts.database, opts.tenantId, eventType);

    // ── Panel de control (in-app) ──────────────────────────────────────────
    if (prefs.dashboard) {
      await storePlatformEvent(opts.database, {
        tenantId: opts.tenantId,
        eventType,
        title,
        body,
        payload: data,
        recipientUserId,
        targetRoles,
        sourceEntityType: opts.sourceEntityType,
        sourceEntityId: opts.sourceEntityId,
      });
    }

    if (rowId) {
      // ── Matrix-governed event: send Email / SMS per the saved switches ─────
      if (prefs.email || prefs.sms) {
        const { emails, phones } = await resolveRecipients(
          opts.database,
          opts.tenantId,
          template,
          {
            recipientUserId: opts.recipientUserId,
            recipientEmail: opts.recipientEmail,
            recipientPhone: opts.recipientPhone,
            assignedPostSiteId: opts.assignedPostSiteId,
          },
        );

        // Fold in any explicit extra recipients (client account, tenant…) and
        // dedupe against the role-resolved list.
        const allEmails = Array.from(
          new Set(
            [...emails, ...(opts.extraEmails || [])]
              .map((e) => (e || '').trim())
              .filter(Boolean),
          ),
        );

        if (prefs.email && allEmails.length) {
          const subject = template.emailSubject ? template.emailSubject(data) : title;
          const fragment = template.emailHtml ? template.emailHtml(data) : `<p>${body}</p>`;
          const html = await brandWrapEmail(opts.database, opts.tenantId, subject, fragment);
          sendMail({ to: allEmails, subject, html }).catch((err) => {
            console.error('[NotificationDispatcher] Email send failed:', err?.message || err);
          });
        }

        if (prefs.sms && phones.length) {
          // Title + body go down separately: the central sanitizer (smsText)
          // joins them as 'title: body', strips emoji (every template title
          // starts with one), folds non-GSM accents and truncates to one
          // GSM segment — so the title is no longer silently dropped and the
          // send never falls into 70-char UCS-2 billing.
          sendSmsForTenant(opts.database, opts.tenantId, phones, body, { title }).catch((err) => {
            console.error('[NotificationDispatcher] SMS send failed:', err?.message || err);
          });
        }
      }
    } else {
      // ── Unmapped event (e.g. memo): legacy email path ──────────────────────
      if (template.sendEmail && opts.recipientEmail && template.emailSubject) {
        const prefKey = EVENT_EMAIL_KEY[eventType];
        let emailAllowed = true;
        if (prefKey) {
          try {
            emailAllowed = await isEmailEnabled(opts.database, opts.tenantId, prefKey);
          } catch {
            emailAllowed = true;
          }
        }
        if (emailAllowed) {
          const subject = template.emailSubject(data);
          const fragment = template.emailHtml ? template.emailHtml(data) : `<p>${body}</p>`;
          const html = await brandWrapEmail(opts.database, opts.tenantId, subject, fragment);
          sendMail({ to: opts.recipientEmail, subject, html }).catch((err) => {
            console.error('[NotificationDispatcher] Email send failed:', err?.message || err);
          });
        }
      }
    }
  } catch (err) {
    // Never crash caller services due to notification failures
    console.error('[NotificationDispatcher] dispatch failed:', err?.message || err);
  }
}

export default { dispatch };
