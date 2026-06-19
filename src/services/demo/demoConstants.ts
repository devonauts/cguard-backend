/**
 * Demo product — stable identity constants and demo-tenant resolution.
 *
 * Component B (the orchestrator) NEVER hard-codes entity ids. Instead it resolves
 * every demo actor/site by its STABLE email or slug (the seed in Component A
 * prints these). This file is the single source of truth for those stable keys,
 * plus the HARD-SAFETY resolution of which tenant is "the demo tenant".
 *
 * HARD SAFETY: the demo tenant is identified by `DEMO_TENANT_ID` (env or
 * superadmin setting). The slug is only a *fallback* lookup used to discover the
 * id; once discovered it is validated against the env/setting if one is present.
 * It is impossible to run a demo action against any tenant whose id is not the
 * resolved demo tenant id (see assertDemoTenant()).
 */

/** Stable slug stored on tenant.url for the demo tenant (set by the seed). */
export const DEMO_TENANT_SLUG = 'vigilancia-andina-demo';
export const DEMO_TENANT_NAME = 'Vigilancia Andina Demo';

/** Stable login emails for every demo account (lower-cased, seed-owned). */
export const DEMO_EMAILS = {
  admin: 'admin@demo.cguardpro.com',
  client: 'cliente@demo.cguardpro.com',
  guardDay: 'guardia.dia@demo.cguardpro.com',
  guardNight: 'guardia.noche@demo.cguardpro.com',
} as const;

/** Stable display names (used only for human-readable result strings/fallbacks). */
export const DEMO_NAMES = {
  admin: 'Carlos Méndez',
  client: 'María Torres',
  guardDay: 'Juan Ramírez',
  guardNight: 'Pedro Vásquez',
  clientCompany: 'Comercial Pacífico S.A.',
  site: 'Torre Empresarial Pacífico',
} as const;

/** Visitor / incident fixtures the steps create (stable so reset can find them). */
export const DEMO_FIXTURES = {
  visitorFirstName: 'Roberto',
  visitorLastName: 'Salas',
  visitorIdNumber: '0912345678',
  visitorCompany: 'Constructora Salas Cía. Ltda.',
  visitorReason: 'Reunión con administración',
  incidentTitle: 'Persona sospechosa en el perímetro',
  incidentDescription:
    'El guardia reporta una persona merodeando junto al acceso vehicular. Se mantiene vigilancia y se solicita verificación por cámaras.',
  incidentPhotoUrl: 'https://picsum.photos/seed/cguard-incident/800/600',
} as const;

/** Settings key under which the superadmin panel can persist the demo tenant id. */
export const DEMO_TENANT_ID_SETTING = 'demoTenantId';

/**
 * Resolve the configured demo tenant id from env or the global settings row.
 * Returns null if nothing is configured — callers then fall back to slug lookup.
 *
 * `db` is the cross-tenant Sequelize bag (req.database). Settings is a per-tenant
 * row, so we read it scoped to the slug-resolved tenant in the service; here we
 * only consult the environment, which is the authoritative kill-switch on prod.
 */
export function configuredDemoTenantId(): string | null {
  const v = (process.env.DEMO_TENANT_ID || '').trim();
  return v || null;
}
