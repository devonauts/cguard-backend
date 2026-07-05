/**
 * Shared incident helpers for the supervisor API (list + detail + actions).
 *
 * The workflow status (open / in-progress / resolved) is richer than the DB
 * `status` enum (abierto | cerrado), so we track transitions as events in the
 * existing `comments` JSON column (an activity log) and derive the displayed
 * status from the latest status event, falling back to the enum.
 */

export type Severity = 'critical' | 'high' | 'medium' | 'low';
export type WorkStatus = 'open' | 'inProgress' | 'resolved' | 'closed';

export interface LogEvent {
  type: 'note' | 'status' | 'assign' | 'escalate' | 'dispatch';
  title?: string;
  text?: string;
  value?: string; // for status: open|inProgress|resolved|closed
  by?: string | null;
  at?: string | null;
}

export function normSeverity(v: any): Severity {
  const s = String(v || '').trim().toLowerCase();
  if (['critical', 'critico', 'crítico', 'urgent', 'urgente'].includes(s)) return 'critical';
  if (['high', 'alto', 'alta'].includes(s)) return 'high';
  if (['low', 'bajo', 'baja'].includes(s)) return 'low';
  return 'medium';
}

export function severityLevel(sev: Severity): number {
  return ({ critical: 5, high: 4, medium: 3, low: 2 } as Record<Severity, number>)[sev] || 3;
}

/** Parse the `comments` column into an activity-log array (handles legacy shapes). */
export function parseLog(comments: any): LogEvent[] {
  if (Array.isArray(comments)) return comments as LogEvent[];
  if (typeof comments === 'string' && comments.trim()) {
    try {
      const p = JSON.parse(comments);
      if (Array.isArray(p)) return p as LogEvent[];
    } catch {
      /* legacy free-text comment */
    }
    return [{ type: 'note', title: 'Note', text: comments, by: null, at: null }];
  }
  return [];
}

/** Displayed workflow status: latest status event, else derived from the enum. */
export function statusFromLog(log: LogEvent[], enumStatus: any): WorkStatus {
  const last = [...log].reverse().find((e) => e.type === 'status' && e.value);
  if (last && ['open', 'inProgress', 'resolved', 'closed'].includes(String(last.value))) {
    return last.value as WorkStatus;
  }
  const s = String(enumStatus || '').trim().toLowerCase();
  if (['cerrado', 'cerrada', 'closed'].includes(s)) return 'resolved';
  return 'open';
}

/** Stable human reference like INC-2026-04213. */
export function referenceFor(id: string, createdAt: any): string {
  const year = new Date(createdAt || Date.now()).getFullYear();
  let n = 0;
  for (const c of String(id)) n = (n * 31 + c.charCodeAt(0)) % 100000;
  return `INC-${year}-${String(n).padStart(5, '0')}`;
}
