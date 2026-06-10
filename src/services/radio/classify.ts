/**
 * Lightweight Spanish keyword classifier for a radio-check reply. Used as a cheap
 * first pass (and the only pass when OpenAI is unavailable). Kept in its own
 * module so both radioCheckService and radioCheckAiService can use it without a
 * circular import.
 */
export type RadioClassification = 'sin_novedad' | 'novedad' | 'incident' | 'unknown';

export function classifyText(text: string): RadioClassification {
  const t = String(text || '').toLowerCase();
  if (!t.trim()) return 'unknown';
  if (/(robo|asalto|incendio|herido|emerg|disparo|intrus|forz|alarma|peligro|accidente|sospechos)/.test(t)) return 'incident';
  if (/(sin novedad|todo (bien|normal|tranquilo|en orden)|novedad ninguna|nada que reportar|sin particular)/.test(t)) return 'sin_novedad';
  return 'novedad';
}
