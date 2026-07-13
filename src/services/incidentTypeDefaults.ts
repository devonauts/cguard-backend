/**
 * Default incident-type catalog, seeded lazily the first time a tenant's
 * (truly virgin) catalog is listed. Names match the worker/supervisor apps'
 * built-in Spanish taxonomy EXACTLY — the apps resolve the selected label
 * back to a catalog id by name, so matching strings is what makes a guard's
 * "Robo / hurto" persist as a real incidentTypeId instead of getting lost.
 *
 * Seeds ONLY when the tenant never had any incident types (paranoid:false
 * count — a tenant that deliberately deleted their types is left alone).
 */

export const DEFAULT_INCIDENT_TYPES: string[] = [
  'Acceso no autorizado',
  'Brecha de perímetro',
  'Robo / hurto',
  'Vandalismo',
  'Intrusión',
  'Persona sospechosa',
  'Paquete sospechoso',
  'Acceso por arrastre (tailgating)',
  'Riña / agresión',
  'Emergencia médica',
  'Incendio / alarma',
  'Daño a la propiedad',
  'Incidente vehicular',
  'Objetos perdidos',
  'Falla de equipo / sistema',
  'Permanencia excesiva de visitante',
  'Riesgo de seguridad',
  'Violación de políticas',
  'Observación de ronda',
  'Otro',
];

export async function ensureDefaultIncidentTypes(
  db: any,
  tenantId: string,
  currentUserId?: string | null,
): Promise<boolean> {
  try {
    if (!db?.incidentType || !tenantId) return false;
    // paranoid:false → soft-deleted rows count as "has had types".
    const everHad = await db.incidentType.count({
      where: { tenantId },
      paranoid: false,
    });
    if (everHad > 0) return false;

    for (const name of DEFAULT_INCIDENT_TYPES) {
      // findOrCreate narrows the double-seed window under concurrent lists.
      await db.incidentType.findOrCreate({
        where: { tenantId, name },
        defaults: {
          name,
          active: true,
          tenantId,
          createdById: currentUserId || null,
        },
      });
    }
    return true;
  } catch (err) {
    console.warn('[incidentTypeDefaults] seed failed:', (err as any)?.message || err);
    return false;
  }
}

export default { ensureDefaultIncidentTypes, DEFAULT_INCIDENT_TYPES };
