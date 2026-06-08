/**
 * Real-time push for the alarm operator console. Writes a platform_events row
 * (the SSE stream /api/:tenantId/events/stream delivers it) + socket.io, both via
 * storePlatformEvent. Targeted at the monitoring/operator roles. Best-effort.
 */
import { storePlatformEvent } from '../../lib/platformEventStore';

const OPERATOR_ROLES = 'admin,owner,operationsManager,securitySupervisor,dispatcher';

export async function emitAlarmEvent(
  db: any,
  tenantId: string,
  ev: { eventType: string; title: string; body?: string; caseId?: string; payload?: any },
): Promise<void> {
  try {
    await storePlatformEvent(db, {
      tenantId,
      eventType: ev.eventType, // e.g. alarm.case.new | alarm.case.updated | alarm.case.escalated
      title: ev.title,
      body: ev.body || '',
      payload: { ...(ev.payload || {}), caseId: ev.caseId },
      targetRoles: OPERATOR_ROLES,
      sourceEntityType: 'alarmCase',
      sourceEntityId: ev.caseId,
    });
  } catch (e: any) {
    console.warn('[alarm] emitAlarmEvent failed:', e?.message || e);
  }
}
