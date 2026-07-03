/**
 * Feature entitlements registry — the canonical list of plan-gateable features.
 *
 * A plan (planCatalog row) carries a `features` array of these keys; a tenant is
 * entitled to a feature when its plan includes the key. This is the single
 * source of truth shared by the superadmin catalog editor and the CRM gate.
 *
 * ROLLOUT SAFETY: entitlement checks FAIL OPEN. If a tenant's plan has no
 * catalog entry (or the catalog is unconfigured), the tenant is granted ALL
 * features. The built-in tiers are seeded with every feature so enabling this
 * mechanism changes NO behavior until a superadmin deliberately narrows a tier.
 */

export interface FeatureDef {
  key: string;
  /** Spanish label shown in the superadmin catalog editor + CRM. */
  label: string;
  description: string;
}

/** All gateable features. Keys are stable identifiers — do not rename. */
export const FEATURES: FeatureDef[] = [
  { key: 'rondas', label: 'Rondas / Patrullaje', description: 'Rondas de vigilancia y patrullaje con escaneo de puntos.' },
  { key: 'video', label: 'Videovigilancia', description: 'Cámaras, DVR y sitios remotos.' },
  { key: 'entrenamiento', label: 'Entrenamiento', description: 'Cursos, lecciones, evaluaciones y certificados.' },
  { key: 'messaging', label: 'Mensajería / Grupos', description: 'Chats grupales estilo WhatsApp y notas de voz.' },
  { key: 'radio', label: 'Radio / PTT', description: 'Pase de novedades por radio y push-to-talk.' },
  { key: 'tasks', label: 'Tareas de cliente', description: 'Tareas solicitadas por el cliente con aprobación.' },
  { key: 'passdowns', label: 'Pase de turno', description: 'Relevo y novedades entre vigilantes.' },
  { key: 'scheduling', label: 'Programador de horarios', description: 'Rotación de turnos y cobertura de sacafrancos.' },
  { key: 'reports', label: 'Reportes avanzados', description: 'Reportería y analítica avanzada.' },
  { key: 'multi_client', label: 'Multi-acceso de cliente', description: 'Varios usuarios por cuenta de cliente.' },
  { key: 'supervisor_app', label: 'App de supervisor', description: 'Patrullaje vehicular / app de supervisor.' },
  { key: 'panic_sos', label: 'Pánico / SOS', description: 'Botón de pánico y SOS de Mi Seguridad.' },
];

/** Every feature key — the default entitlement set (fail-open + seeded tiers). */
export const ALL_FEATURE_KEYS: string[] = FEATURES.map((f) => f.key);

const VALID = new Set(ALL_FEATURE_KEYS);

/** Keep only recognized feature keys from an arbitrary array (dedup + validate). */
export function sanitizeFeatures(input: any): string[] {
  if (!Array.isArray(input)) return [];
  const out: string[] = [];
  for (const k of input) {
    const key = String(k);
    if (VALID.has(key) && !out.includes(key)) out.push(key);
  }
  return out;
}

/** Does an entitlement set grant a feature? Empty/absent set = fail open (true). */
export function hasFeature(features: string[] | null | undefined, key: string): boolean {
  if (!features || features.length === 0) return true; // fail open
  return features.includes(key);
}

export default { FEATURES, ALL_FEATURE_KEYS, sanitizeFeatures, hasFeature };
