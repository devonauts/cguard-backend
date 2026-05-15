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

    // Store in DB — SSE clients will pick it up via polling
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

    // Send email for critical events when a recipient address is available
    if (template.sendEmail && opts.recipientEmail && template.emailSubject) {
      const subject = template.emailSubject(data);
      const html = template.emailHtml ? template.emailHtml(data) : `<p>${body}</p>`;
      sendMail({ to: opts.recipientEmail, subject, html }).catch((err) => {
        console.error('[NotificationDispatcher] Email send failed:', err?.message || err);
      });
    }
  } catch (err) {
    // Never crash caller services due to notification failures
    console.error('[NotificationDispatcher] dispatch failed:', err?.message || err);
  }
}

export default { dispatch };
