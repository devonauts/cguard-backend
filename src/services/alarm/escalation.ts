/**
 * SLA escalation sweep. Finds still-queued (unacknowledged) cases past their
 * time-to-acknowledge SLA and escalates them: bump priority, raise slaLevel,
 * audit, push, and emit a real-time 'alarm.case.escalated' event so the operator
 * console flags it. Runs cross-tenant from the always-on receiver process.
 */
import { emitAlarmEvent } from './realtime';

// Time-to-acknowledge SLA (minutes) by priority (1=critical … 5=info).
const SLA_MINS: Record<number, number> = { 1: 2, 2: 5, 3: 15, 4: 30, 5: 60 };

export async function runEscalationSweep(db: any): Promise<number> {
  let escalated = 0;
  try {
    const cases = await db.alarmCase.findAll({ where: { status: 'queued' }, limit: 500 });
    const now = Date.now();
    for (const c of cases) {
      const created = new Date(c.createdAt).getTime();
      const ageMin = (now - created) / 60000;
      const threshold = SLA_MINS[c.priority] || 15;
      // Level 1 at the SLA, level 2 at 2× the SLA. Escalate once per level crossing.
      const dueLevel = ageMin >= threshold * 2 ? 2 : ageMin >= threshold ? 1 : 0;
      if (dueLevel > (c.slaLevel || 0)) {
        const newPriority = Math.max(1, c.priority - 1);
        await c.update({ slaLevel: dueLevel, escalatedAt: new Date(), priority: newPriority });
        await db.alarmAuditLog.create({
          alarmCaseId: c.id,
          action: 'escalate',
          detail: `SLA excedido (${Math.round(ageMin)} min sin reconocer) — nivel ${dueLevel}, prioridad ${newPriority}`,
          actorId: null,
          at: new Date(),
          tenantId: c.tenantId,
        });
        await emitAlarmEvent(db, c.tenantId, {
          eventType: 'alarm.case.escalated',
          title: 'Alarma escalada (SLA)',
          body: `Caso sin atender ${Math.round(ageMin)} min`,
          caseId: c.id,
          payload: { priority: newPriority, slaLevel: dueLevel },
        });
        try {
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          require('../pushService').pushToTenant(db, c.tenantId, {
            title: 'Alarma sin atender',
            body: 'Un caso superó el SLA y fue escalado',
            data: { type: 'alarm_escalated', caseId: c.id },
          });
        } catch { /* best-effort */ }
        escalated += 1;
      }
    }
  } catch (e: any) {
    console.warn('[alarm] escalation sweep failed:', e?.message || e);
  }
  return escalated;
}
