/**
 * CommunicationService — the FACADE for the unified communications layer. The
 * rest of the app calls THIS (never Twilio/Meta/Firebase directly). Each method
 * is a typed wrapper that builds a MessageIntent and hands it to the
 * MessageRouter, which applies the routing rules, wallet-gates paid channels and
 * logs every attempt.
 *
 * FOUNDATION STATE: every method is wired and compiles. The push path works
 * today; WhatsApp/SMS/Email return 'skipped' until the Providers agent fills the
 * providers and the Routing agent completes the per-type rules. Method
 * SIGNATURES ARE THE CONTRACT — other agents must not change them.
 */
import { route } from './messageRouter';
import { MessageIntent, MessageType, SendResult } from './types';

// ---------------------------------------------------------------------------
// Low-level single-channel helpers (explicit channel; bypass routing cascade).
// ---------------------------------------------------------------------------

export interface PushArgs {
  tenantId: string;
  userId: string;
  title: string;
  body: string;
  deepLink?: string;
  data?: Record<string, string>;
  messageType?: MessageType;
  critical?: boolean;
}
export async function sendPushNotification(db: any, args: PushArgs): Promise<SendResult[]> {
  return route(db, {
    tenantId: args.tenantId,
    userId: args.userId,
    messageType: args.messageType || 'generic',
    critical: args.critical,
    channels: ['push'],
    title: args.title,
    body: args.body,
    deepLink: args.deepLink,
    data: args.data,
  });
}

export interface WhatsAppArgs {
  tenantId: string;
  userId?: string;
  phone: string;
  body?: string;
  templateName?: string;
  templateVars?: Record<string, string>;
  languageCode?: string;
  messageType?: MessageType;
  critical?: boolean;
}
export async function sendWhatsAppMessage(db: any, args: WhatsAppArgs): Promise<SendResult[]> {
  return route(db, {
    tenantId: args.tenantId,
    userId: args.userId,
    phone: args.phone,
    messageType: args.messageType || 'generic',
    critical: args.critical,
    channels: ['whatsapp'],
    body: args.body,
    templateName: args.templateName,
    templateVars: args.templateVars,
    languageCode: args.languageCode,
  });
}

export interface SmsArgs {
  tenantId: string;
  userId?: string;
  phone: string;
  body: string;
  messageType?: MessageType;
  critical?: boolean;
}
export async function sendSms(db: any, args: SmsArgs): Promise<SendResult[]> {
  return route(db, {
    tenantId: args.tenantId,
    userId: args.userId,
    phone: args.phone,
    messageType: args.messageType || 'generic',
    critical: args.critical,
    channels: ['sms'],
    body: args.body,
  });
}

export interface EmailArgs {
  tenantId: string;
  userId?: string;
  email: string;
  title: string;
  body: string;
  messageType?: MessageType;
}
export async function sendEmail(db: any, args: EmailArgs): Promise<SendResult[]> {
  return route(db, {
    tenantId: args.tenantId,
    userId: args.userId,
    email: args.email,
    messageType: args.messageType || 'generic',
    channels: ['email'],
    title: args.title,
    body: args.body,
  });
}

// ---------------------------------------------------------------------------
// High-level intent helpers (router decides channels + order per the rules).
// ---------------------------------------------------------------------------

export interface OperationalAlertArgs {
  tenantId: string;
  userId?: string;
  phone?: string;
  email?: string;
  title: string;
  body: string;
  deepLink?: string;
  data?: Record<string, string>;
  messageType?: MessageType;
  critical?: boolean;
  channels?: MessageIntent['channels'];
}
/** Generic operational alert — push-first cascade per the routing rules. */
export async function sendOperationalAlert(
  db: any,
  args: OperationalAlertArgs,
): Promise<SendResult[]> {
  return route(db, {
    tenantId: args.tenantId,
    userId: args.userId,
    phone: args.phone,
    email: args.email,
    messageType: args.messageType || 'generic',
    critical: args.critical,
    channels: args.channels,
    title: args.title,
    body: args.body,
    deepLink: args.deepLink,
    data: args.data,
  });
}

export interface OtpArgs {
  tenantId: string;
  userId?: string;
  phone: string;
  /** Optional — generated (6-digit) when omitted. */
  code?: string;
  languageCode?: string;
}
export interface OtpResult {
  code: string;
  results: SendResult[];
}
/** Generate a numeric OTP of the given length (default 6). */
function generateOtpCode(length = 6): string {
  let out = '';
  for (let i = 0; i < length; i += 1) out += Math.floor(Math.random() * 10);
  return out;
}
/**
 * OTP — accepts a code or generates a 6-digit one. Delivered over WhatsApp using
 * the AUTHENTICATION template (whatsappTemplates 'otp_code') when
 * otp_preferred_channel='whatsapp' and WhatsApp is enabled, otherwise SMS. NEVER
 * free-form WhatsApp text (the Meta provider rejects OTP without a template).
 * Returns the resolved code alongside the per-channel results so the caller can
 * persist/verify it.
 */
export async function sendOtp(db: any, args: OtpArgs): Promise<OtpResult> {
  const code = args.code || generateOtpCode();
  const results = await route(db, {
    tenantId: args.tenantId,
    userId: args.userId,
    phone: args.phone,
    messageType: 'otp',
    critical: true,
    templateName: 'otp_code',
    templateVars: { '1': code },
    languageCode: args.languageCode,
    body: `Tu código de verificación es ${code}`, // SMS fallback body only
  });
  return { code, results };
}

export interface ShiftReminderArgs {
  tenantId: string;
  userId: string;
  phone?: string;
  title: string;
  body: string;
  shiftId?: string;
  data?: Record<string, string>;
}
/** Shift reminder — push first; WhatsApp if no token / tenant enables it; SMS fallback. */
export async function sendShiftReminder(db: any, args: ShiftReminderArgs): Promise<SendResult[]> {
  return route(db, {
    tenantId: args.tenantId,
    userId: args.userId,
    phone: args.phone,
    messageType: 'shift_reminder',
    title: args.title,
    body: args.body,
    deepLink: args.shiftId ? `cguardpro://shifts/${args.shiftId}` : undefined,
    data: args.data,
  });
}

export interface IncidentAlertArgs {
  tenantId: string;
  userId?: string;
  phone?: string;
  title: string;
  body: string;
  incidentId?: string;
  critical?: boolean;
  data?: Record<string, string>;
}
/** Incident — push + WhatsApp to supervisors/admins; includes deep link. */
export async function sendIncidentAlert(db: any, args: IncidentAlertArgs): Promise<SendResult[]> {
  return route(db, {
    tenantId: args.tenantId,
    userId: args.userId,
    phone: args.phone,
    messageType: 'incident_alert',
    critical: args.critical,
    title: args.title,
    body: args.body,
    deepLink: args.incidentId ? `cguardpro://incidents/${args.incidentId}` : undefined,
    data: args.data,
  });
}

export interface VisitorAlertArgs {
  tenantId: string;
  userId?: string;
  phone?: string;
  title: string;
  body: string;
  visitorId?: string;
  data?: Record<string, string>;
}
/** Visitor — push first; WhatsApp optional per setting; SMS only if fallback enabled. */
export async function sendVisitorAlert(db: any, args: VisitorAlertArgs): Promise<SendResult[]> {
  return route(db, {
    tenantId: args.tenantId,
    userId: args.userId,
    phone: args.phone,
    messageType: 'visitor_alert',
    title: args.title,
    body: args.body,
    deepLink: args.visitorId ? `cguardpro://visitors/${args.visitorId}` : undefined,
    data: args.data,
  });
}

export interface RondaAlertArgs {
  tenantId: string;
  userId?: string;
  phone?: string;
  title: string;
  body: string;
  rondaId?: string;
  critical?: boolean;
  data?: Record<string, string>;
}
/** Ronda missed checkpoint — push + WhatsApp to supervisor; SMS only if critical configured. */
export async function sendRondaAlert(db: any, args: RondaAlertArgs): Promise<SendResult[]> {
  return route(db, {
    tenantId: args.tenantId,
    userId: args.userId,
    phone: args.phone,
    messageType: 'ronda_alert',
    critical: args.critical,
    title: args.title,
    body: args.body,
    deepLink: args.rondaId ? `cguardpro://rondas/${args.rondaId}` : undefined,
    data: args.data,
  });
}

export interface NoShowAlertArgs {
  tenantId: string;
  userId?: string;
  phone?: string;
  title: string;
  body: string;
  shiftId?: string;
  critical?: boolean;
  data?: Record<string, string>;
}
/** No-show — operational alert; critical by default (push + WhatsApp + SMS fan-out). */
export async function sendNoShowAlert(db: any, args: NoShowAlertArgs): Promise<SendResult[]> {
  return route(db, {
    tenantId: args.tenantId,
    userId: args.userId,
    phone: args.phone,
    messageType: 'no_show',
    critical: args.critical !== false,
    title: args.title,
    body: args.body,
    deepLink: args.shiftId ? `cguardpro://shifts/${args.shiftId}` : undefined,
    data: args.data,
  });
}

export interface TaskAssignedArgs {
  tenantId: string;
  userId: string;
  phone?: string;
  title: string;
  body: string;
  taskId?: string;
  data?: Record<string, string>;
}
/** Task assigned — push first; WhatsApp/SMS per rules. */
export async function sendTaskAssignedAlert(
  db: any,
  args: TaskAssignedArgs,
): Promise<SendResult[]> {
  return route(db, {
    tenantId: args.tenantId,
    userId: args.userId,
    phone: args.phone,
    messageType: 'task_alert',
    title: args.title,
    body: args.body,
    deepLink: args.taskId ? `cguardpro://tasks/${args.taskId}` : undefined,
    data: args.data,
  });
}

export interface EscalationArgs {
  tenantId: string;
  userId?: string;
  phone?: string;
  title: string;
  body: string;
  deepLink?: string;
  critical?: boolean;
  data?: Record<string, string>;
}
/** Escalation — critical by default; push + WhatsApp + SMS fan-out. */
export async function sendEscalationAlert(db: any, args: EscalationArgs): Promise<SendResult[]> {
  return route(db, {
    tenantId: args.tenantId,
    userId: args.userId,
    phone: args.phone,
    messageType: 'escalation',
    critical: args.critical !== false,
    title: args.title,
    body: args.body,
    deepLink: args.deepLink,
    data: args.data,
  });
}

export const CommunicationService = {
  sendPushNotification,
  sendWhatsAppMessage,
  sendSms,
  sendEmail,
  sendOperationalAlert,
  sendOtp,
  sendShiftReminder,
  sendIncidentAlert,
  sendVisitorAlert,
  sendRondaAlert,
  sendNoShowAlert,
  sendTaskAssignedAlert,
  sendEscalationAlert,
};

export default CommunicationService;
