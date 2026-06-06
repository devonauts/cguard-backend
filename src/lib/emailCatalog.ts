/**
 * Canonical catalog of every transactional/notification email the platform
 * sends. Drives the "Preferencias de correo" settings screen (order + labels)
 * and the per-tenant on/off enforcement.
 *
 * `locked: true` means the email is required (security/auth) and cannot be
 * disabled — the UI shows the switch on and disabled.
 * `eventType` links a notification email to its dispatch() eventType so the
 * notification dispatcher can gate it centrally.
 */
export interface EmailCatalogItem {
  key: string;
  label: string;
  description: string;
  category: string;
  locked?: boolean;
  eventType?: string;
}

export const EMAIL_CATALOG: EmailCatalogItem[] = [
  // ── Identidad y acceso ────────────────────────────────────────────────
  {
    key: 'clientWelcome',
    label: 'Bienvenida al cliente',
    description:
      'Se envía automáticamente al agregar un cliente con correo. Le da la bienvenida y le permite activar su acceso al portal.',
    category: 'Identidad y acceso',
  },
  {
    key: 'appInvite',
    label: 'Invitación a la app Mi Seguridad',
    description:
      'Acción manual "Invitar a la app" desde el cliente: lo invita a descargar y usar la aplicación Mi Seguridad.',
    category: 'Identidad y acceso',
  },
  {
    key: 'staffInvite',
    label: 'Invitación a personal y guardias',
    description:
      'Invita a guardias y personal a unirse a la plataforma y crear su cuenta de acceso.',
    category: 'Identidad y acceso',
  },
  {
    key: 'emailVerification',
    label: 'Verificación de correo',
    description: 'Confirma la dirección de correo del usuario al registrarse.',
    category: 'Identidad y acceso',
    locked: true,
  },
  {
    key: 'passwordReset',
    label: 'Restablecimiento de contraseña',
    description: 'Permite a los usuarios recuperar el acceso a su cuenta.',
    category: 'Identidad y acceso',
    locked: true,
  },

  // ── Facturación ───────────────────────────────────────────────────────
  {
    key: 'invoice',
    label: 'Envío de facturas',
    description: 'Envía la factura al cliente, con el PDF adjunto.',
    category: 'Facturación',
  },
  {
    key: 'estimate',
    label: 'Envío de cotizaciones',
    description: 'Envía la cotización o presupuesto al cliente.',
    category: 'Facturación',
  },

  // ── Operación ─────────────────────────────────────────────────────────
  // NOTE: incidents, rondas and time-off notifications are configured (with
  // Panel / Correo / SMS channels) in Configuración → Notificaciones, not here.
  {
    key: 'memo',
    label: 'Memo a guardia',
    description: 'Notifica al guardia cuando recibe un memo dirigido a él.',
    category: 'Operación',
    eventType: 'memo.created',
  },
];

/** eventType → preference key, for centrally gating notification emails. */
export const EVENT_EMAIL_KEY: Record<string, string> = EMAIL_CATALOG.reduce(
  (acc: Record<string, string>, item) => {
    if (item.eventType) acc[item.eventType] = item.key;
    return acc;
  },
  {},
);

/** All preferences default to ON. */
export function defaultPreferences(): Record<string, boolean> {
  return EMAIL_CATALOG.reduce((acc: Record<string, boolean>, item) => {
    acc[item.key] = true;
    return acc;
  }, {});
}

export function isLocked(key: string): boolean {
  const item = EMAIL_CATALOG.find((i) => i.key === key);
  return !!(item && item.locked);
}
