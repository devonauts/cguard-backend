/**
 * Unified communications layer — shared enums + interfaces (the integration
 * contract). Every provider, the router, the facade, the log service and the
 * settings service speak these types. Do NOT add provider-specific shapes here.
 */

export type Channel = 'push' | 'whatsapp' | 'sms' | 'email';

export type MessageType =
  | 'otp'
  | 'shift_reminder'
  | 'incident_alert'
  | 'visitor_alert'
  | 'ronda_alert'
  | 'task_alert'
  | 'no_show'
  | 'panic'
  | 'new_assignment'
  | 'escalation'
  | 'generic';

export type DeliveryStatus = 'queued' | 'sent' | 'delivered' | 'read' | 'failed' | 'skipped';

/** Result of a single provider send attempt on a single channel. */
export interface SendResult {
  status: DeliveryStatus;
  channel?: Channel;
  provider?: string;
  providerMessageId?: string;
  providerResponse?: any;
  error?: string;
  costEstimateCents?: number;
  billedAmountCents?: number;
  /** Set when status === 'skipped' (e.g. 'insufficient_balance', 'not_configured'). */
  skipReason?: string;
}

/**
 * A fully-resolved outbound message for ONE channel + ONE recipient. The router
 * builds these from a higher-level intent; providers consume them.
 */
export interface OutboundMessage {
  tenantId: string;
  userId?: string;
  /** E.164 phone, email address, or device-owner userId for push. */
  recipient: string;
  channel: Channel;
  messageType: MessageType;
  title?: string;
  body?: string;
  /** WhatsApp template name (required for template sends / OTP). */
  templateName?: string;
  /** Ordered/keyed template body params. */
  templateVars?: Record<string, string>;
  languageCode?: string;
  /** Deep link, e.g. cguardpro://incidents/:id — included in push data + body. */
  deepLink?: string;
  /** Extra push data payload (string→string per FCM). */
  data?: Record<string, string>;
  critical?: boolean;
}

/** A provider implements exactly one Channel. */
export interface CommunicationProvider {
  channel: Channel;
  /** True when this channel is usable for the tenant (creds present, etc.). */
  isConfigured(db: any, tenantId: string): Promise<boolean>;
  send(db: any, msg: OutboundMessage): Promise<SendResult>;
}

/**
 * A higher-level routing intent: "deliver this to these recipients" — the
 * MessageRouter decides which channels to attempt and in what order per the
 * routing rules. Channel-specific fields are optional and filled per channel.
 */
export interface MessageIntent {
  tenantId: string;
  messageType: MessageType;
  critical?: boolean;
  /** Optional explicit channel order/override; otherwise rules decide. */
  channels?: Channel[];
  /** A single user target (resolves push token + phone/email as needed). */
  userId?: string;
  /** Explicit recipients per channel when not derivable from userId. */
  phone?: string;
  email?: string;
  title?: string;
  body?: string;
  templateName?: string;
  templateVars?: Record<string, string>;
  languageCode?: string;
  deepLink?: string;
  data?: Record<string, string>;
}

/** Per-tenant communication settings (merged with defaults). */
export interface CommunicationSettings {
  push_enabled: boolean;
  whatsapp_enabled: boolean;
  sms_enabled: boolean;
  email_enabled: boolean;
  whatsapp_provider: 'meta';
  sms_provider: 'twilio';
  critical_alert_sms_fallback: boolean;
  otp_preferred_channel: 'whatsapp' | 'sms';
  wallet_required_for_paid_channels: boolean;
  low_balance_threshold: number;
  allow_negative_communications_balance: boolean;
  default_country_code: string;
  timezone: string | null;
  // Per-event toggles.
  whatsapp_shift_reminders: boolean;
  whatsapp_incidents: boolean;
  sms_critical: boolean;
  // Allow forward-compatible extra keys without losing type-safety on the above.
  [key: string]: any;
}

/** Resolved Meta WhatsApp credentials (decrypted; db→env fallback). */
export interface MetaConfig {
  accessToken: string;
  phoneNumberId: string;
  businessAccountId: string;
  apiVersion: string;
  webhookVerifyToken: string;
  appSecret: string;
  source: 'db' | 'env';
}
