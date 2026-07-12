/**
 * WhatsAppNotificationService — thin, typed wrappers for the product's
 * WhatsApp-facing notifications. Every method builds a MessageIntent and hands
 * it to the EXISTING router/facade (communicationService/messageRouter), which
 * owns routing rules, wallet gating and logging — NOTHING is duplicated here.
 *
 * WhatsApp business-initiated messages outside Meta's 24h window require a
 * pre-approved template; each method carries its conventional templateName
 * (per-tenant rows in whatsappTemplates after syncTemplates, global seeds as
 * fallback). title/body still travel on the intent for the push/SMS legs of
 * the cascade and the in-window free-form WhatsApp case.
 */
import { route } from '../messageRouter';
import { sendIncidentAlert, sendWhatsAppMessage } from '../communicationService';
import { SendResult } from '../types';

/** Who receives the message: a platform user (push-capable) and/or a raw phone. */
export interface WhatsAppRecipient {
  userId?: string;
  phone?: string;
}

/** Common template-driven params: display strings + ordered template vars. */
export interface NotifyParams {
  title: string;
  body: string;
  /** Ordered Meta template body params ({'1': …, '2': …}). */
  templateVars?: Record<string, string>;
  languageCode?: string;
  deepLink?: string;
  data?: Record<string, string>;
  critical?: boolean;
}

/** Shared shape: route a template-carrying intent through the standard rules. */
function notify(
  db: any,
  tenantId: string,
  recipient: WhatsAppRecipient,
  messageType:
    | 'new_assignment'
    | 'incident_alert'
    | 'visitor_alert'
    | 'ronda_alert'
    | 'panic'
    | 'generic',
  templateName: string | undefined,
  params: NotifyParams,
): Promise<SendResult[]> {
  return route(db, {
    tenantId,
    userId: recipient.userId,
    phone: recipient.phone,
    messageType,
    critical: params.critical,
    title: params.title,
    body: params.body,
    templateName,
    templateVars: params.templateVars,
    languageCode: params.languageCode,
    deepLink: params.deepLink,
    data: params.data,
  });
}

/** Vigilante asignado a un puesto/turno. Template: new_assignment. */
export async function sendGuardAssigned(
  db: any,
  tenantId: string,
  recipient: WhatsAppRecipient,
  params: NotifyParams & { shiftId?: string },
): Promise<SendResult[]> {
  return notify(db, tenantId, recipient, 'new_assignment', 'new_assignment', {
    ...params,
    deepLink: params.deepLink || (params.shiftId ? `cguardpro://shifts/${params.shiftId}` : undefined),
  });
}

/** Vigilante marcó entrada (clock-in). Template: guard_arrived. */
export async function sendGuardArrived(
  db: any,
  tenantId: string,
  recipient: WhatsAppRecipient,
  params: NotifyParams,
): Promise<SendResult[]> {
  return notify(db, tenantId, recipient, 'generic', 'guard_arrived', params);
}

/** Vigilante marcó salida (clock-out). Template: guard_checkout. */
export async function sendGuardCheckout(
  db: any,
  tenantId: string,
  recipient: WhatsAppRecipient,
  params: NotifyParams,
): Promise<SendResult[]> {
  return notify(db, tenantId, recipient, 'generic', 'guard_checkout', params);
}

/** Incidente reportado — delegates to the existing facade method (template
 *  incident_alert via the router's per-type default). */
export async function sendIncident(
  db: any,
  tenantId: string,
  recipient: WhatsAppRecipient,
  params: NotifyParams & { incidentId?: string },
): Promise<SendResult[]> {
  return sendIncidentAlert(db, {
    tenantId,
    userId: recipient.userId,
    phone: recipient.phone,
    title: params.title,
    body: params.body,
    incidentId: params.incidentId,
    critical: params.critical,
    data: params.data,
  });
}

/** SOS / botón de pánico — critical fan-out (template panic_alert via router default). */
export async function sendSOS(
  db: any,
  tenantId: string,
  recipient: WhatsAppRecipient,
  params: NotifyParams,
): Promise<SendResult[]> {
  return notify(db, tenantId, recipient, 'panic', undefined, { ...params, critical: true });
}

/** Visita aprobada. Template: visitor_approved. */
export async function sendVisitorApproved(
  db: any,
  tenantId: string,
  recipient: WhatsAppRecipient,
  params: NotifyParams & { visitorId?: string },
): Promise<SendResult[]> {
  return notify(db, tenantId, recipient, 'visitor_alert', 'visitor_approved', {
    ...params,
    deepLink: params.deepLink || (params.visitorId ? `cguardpro://visitors/${params.visitorId}` : undefined),
  });
}

/** Visita denegada. Template: visitor_denied. */
export async function sendVisitorDenied(
  db: any,
  tenantId: string,
  recipient: WhatsAppRecipient,
  params: NotifyParams & { visitorId?: string },
): Promise<SendResult[]> {
  return notify(db, tenantId, recipient, 'visitor_alert', 'visitor_denied', {
    ...params,
    deepLink: params.deepLink || (params.visitorId ? `cguardpro://visitors/${params.visitorId}` : undefined),
  });
}

/** Ronda/patrullaje completado (informational). Template: patrol_completed. */
export async function sendPatrolCompleted(
  db: any,
  tenantId: string,
  recipient: WhatsAppRecipient,
  params: NotifyParams & { rondaId?: string },
): Promise<SendResult[]> {
  return notify(db, tenantId, recipient, 'generic', 'patrol_completed', {
    ...params,
    deepLink: params.deepLink || (params.rondaId ? `cguardpro://rondas/${params.rondaId}` : undefined),
  });
}

/** Recordatorio de factura por vencer/vencida. Template: invoice_reminder. */
export async function sendInvoiceReminder(
  db: any,
  tenantId: string,
  recipient: WhatsAppRecipient,
  params: NotifyParams & { invoiceId?: string },
): Promise<SendResult[]> {
  return notify(db, tenantId, recipient, 'generic', 'invoice_reminder', params);
}

/** Pago recibido / confirmación. Template: payment_received. */
export async function sendPaymentReceived(
  db: any,
  tenantId: string,
  recipient: WhatsAppRecipient,
  params: NotifyParams & { invoiceId?: string },
): Promise<SendResult[]> {
  return notify(db, tenantId, recipient, 'generic', 'payment_received', params);
}

/** Arbitrary approved template, WhatsApp-only (no push/SMS cascade). */
export async function sendCustomTemplate(
  db: any,
  tenantId: string,
  recipient: WhatsAppRecipient,
  params: {
    templateName: string;
    templateVars?: Record<string, string>;
    languageCode?: string;
    body?: string;
    critical?: boolean;
  },
): Promise<SendResult[]> {
  return sendWhatsAppMessage(db, {
    tenantId,
    userId: recipient.userId,
    phone: recipient.phone || '',
    templateName: params.templateName,
    templateVars: params.templateVars,
    languageCode: params.languageCode,
    body: params.body,
    critical: params.critical,
  });
}

export const WhatsAppNotificationService = {
  sendGuardAssigned,
  sendGuardArrived,
  sendGuardCheckout,
  sendIncident,
  sendSOS,
  sendVisitorApproved,
  sendVisitorDenied,
  sendPatrolCompleted,
  sendInvoiceReminder,
  sendPaymentReceived,
  sendCustomTemplate,
};

export default WhatsAppNotificationService;
