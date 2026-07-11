/**
 * Team mobile hub — per-tenant customization of the worker & supervisor apps.
 *
 * Stored as JSON in settings.mobileAppSettings (missing key = default, so new
 * options ship without migrations). Written from the CRM Settings › Hub móvil
 * page through the normal settings PUT; read by the apps via
 * GET /tenant/:id/mobile-app-config (settingsMobileAppConfig.ts).
 *
 * Safety modules (radio, panic/SOS, patrol, incidents, schedule, messages)
 * are NOT toggleable — only convenience modules are listed here.
 */

export interface MobileAppSettings {
  /** Accent hex color applied to the apps' brand tokens; '' = default gold. */
  accentColor: string;
  /** Brand name shown in the app header/login; '' = C-Guard Pro default. */
  displayName: string;
  /** Small tagline under the brand name; '' = default ("Security Operations"). */
  tagline: string;
  /** Show the tenant's company logo (settings.logoUrl) instead of the C-Guard mark. */
  useTenantLogo: boolean;
  /** Default theme for new installs: dark | light | user (device preference). */
  defaultTheme: 'dark' | 'light' | 'user';
  /** Convenience-module visibility in the worker app. */
  modules: {
    training: boolean;
    performance: boolean;
    visitors: boolean;
    timeOff: boolean;
    backup: boolean;
    map: boolean;
  };
}

export const MOBILE_APP_DEFAULTS: MobileAppSettings = {
  accentColor: '',
  displayName: '',
  tagline: '',
  useTenantLogo: true,
  defaultTheme: 'dark',
  modules: {
    training: true,
    performance: true,
    visitors: true,
    timeOff: true,
    backup: true,
    map: true,
  },
};

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

/** Merge stored JSON over defaults and sanitize every field. */
export function resolveMobileAppSettings(raw: any): MobileAppSettings {
  const src = raw && typeof raw === 'object' ? raw : {};
  const modules = src.modules && typeof src.modules === 'object' ? src.modules : {};
  const bool = (v: any, dflt: boolean) => (typeof v === 'boolean' ? v : dflt);
  const text = (v: any, max: number) =>
    typeof v === 'string' ? v.trim().slice(0, max) : '';

  return {
    accentColor: HEX_RE.test(String(src.accentColor || '')) ? String(src.accentColor).toLowerCase() : '',
    displayName: text(src.displayName, 40),
    tagline: text(src.tagline, 60),
    useTenantLogo: bool(src.useTenantLogo, MOBILE_APP_DEFAULTS.useTenantLogo),
    defaultTheme: ['dark', 'light', 'user'].includes(src.defaultTheme)
      ? src.defaultTheme
      : MOBILE_APP_DEFAULTS.defaultTheme,
    modules: {
      training: bool(modules.training, true),
      performance: bool(modules.performance, true),
      visitors: bool(modules.visitors, true),
      timeOff: bool(modules.timeOff, true),
      backup: bool(modules.backup, true),
      map: bool(modules.map, true),
    },
  };
}
