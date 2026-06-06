/**
 * Notification templates for platform events.
 * Maps each eventType to a title/body generator and delivery settings.
 */

export type EventType =
  | 'incident.created'
  | 'incident.updated'
  | 'guard.checkin'
  | 'guard.checkout'
  | 'guard.late'
  | 'visitor.arrival'
  | 'visitor.departure'
  | 'patrol.completed'
  | 'patrol.missed'
  | 'shift.unassigned'
  | 'shift.exchange_requested'
  | 'shift.exchange_approved'
  | 'shift.exchange_rejected'
  | 'memo.created'
  | 'timeoff.requested'
  | 'timeoff.approved'
  | 'timeoff.rejected'
  | 'task.completed'
  | 'task.overdue'
  | 'dispatch.created';

// Role sets for targetRoles field (comma-separated, used with FIND_IN_SET)
export const TARGET_ROLES = {
  SUPERVISORS: 'admin,operationsManager,securitySupervisor',
  HR: 'admin,operationsManager,hrManager',
  DISPATCHER: 'admin,operationsManager,securitySupervisor,dispatcher',
  ALL_STAFF: 'admin,operationsManager,securitySupervisor,hrManager,dispatcher,clientAccountManager',
  SPECIFIC: null, // recipientUserId will be set instead
};

export interface NotificationTemplate {
  title: (data: any) => string;
  body: (data: any) => string;
  targetRoles: string | null;
  sendEmail: boolean;
  emailSubject?: (data: any) => string;
  emailHtml?: (data: any) => string;
}

/** Minimal HTML-escape for values interpolated into email markup. */
function esc(v: any): string {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Render a titled <ul> from a list of strings, or '' when the list is empty. */
function listSection(label: string, items: any): string {
  const arr = Array.isArray(items) ? items.filter(Boolean) : [];
  if (!arr.length) return '';
  const lis = arr.map((i) => `<li>${esc(i)}</li>`).join('');
  return `<p style="margin:16px 0 4px"><strong>${esc(label)}</strong></p><ul style="margin:0 0 8px">${lis}</ul>`;
}

/** Email body for a guard clock-in, including incidents / note / pending items. */
function checkinEmailHtml(d: any): string {
  return `
    <h2>✅ Guardia inició turno</h2>
    ${d.guardName ? `<p><strong>Guardia:</strong> ${esc(d.guardName)}</p>` : ''}
    ${d.siteName ? `<p><strong>Sitio:</strong> ${esc(d.siteName)}</p>` : ''}
    ${d.stationName ? `<p><strong>Puesto:</strong> ${esc(d.stationName)}</p>` : ''}
    ${d.clockInTime ? `<p><strong>Hora de entrada:</strong> ${esc(d.clockInTime)}</p>` : ''}
    ${d.observations ? `<p><strong>Nota del guardia:</strong> ${esc(d.observations)}</p>` : ''}
    ${listSection('Incidentes abiertos en el sitio', d.incidents)}
    ${listSection('Memos pendientes', d.pendingMemos)}
    ${listSection('Consignas pendientes', d.pendingOrders)}
  `;
}

export const TEMPLATES: Record<EventType, NotificationTemplate> = {
  'incident.created': {
    title: (d) =>
      `🚨 Incidente: ${d.incidentTitle || d.title || d.incidentType || 'Nuevo incidente'}`,
    body: (d) =>
      [
        d.guardName && `Guardia: ${d.guardName}`,
        d.siteName && `Sitio: ${d.siteName}`,
        d.description && d.description.slice(0, 120),
      ]
        .filter(Boolean)
        .join('. '),
    targetRoles: TARGET_ROLES.SUPERVISORS,
    sendEmail: true,
    emailSubject: (d) =>
      `[CGuard] Nuevo incidente: ${d.incidentTitle || d.title || 'Incidente'}`,
    emailHtml: (d) => `
      <h2>Nuevo incidente reportado</h2>
      ${d.incidentTitle || d.title ? `<p><strong>Título:</strong> ${d.incidentTitle || d.title}</p>` : ''}
      ${d.guardName ? `<p><strong>Guardia:</strong> ${d.guardName}</p>` : ''}
      ${d.siteName ? `<p><strong>Sitio:</strong> ${d.siteName}</p>` : ''}
      ${d.description ? `<p><strong>Descripción:</strong> ${d.description}</p>` : ''}
    `,
  },
  'incident.updated': {
    title: (d) => `📋 Incidente actualizado`,
    body: (d) =>
      `Estado actualizado${d.siteName ? ` en ${d.siteName}` : ''}`,
    targetRoles: TARGET_ROLES.SUPERVISORS,
    sendEmail: false,
  },
  'guard.checkin': {
    title: (d) => `✅ Check-in: ${d.guardName || 'Guardia'}`,
    body: (d) => {
      const base = `${d.guardName || 'Guardia'} inició turno${d.siteName ? ` en ${d.siteName}` : ''}${d.stationName ? ` — ${d.stationName}` : ''}`;
      const n = Array.isArray(d.incidents) ? d.incidents.length : 0;
      return n > 0 ? `${base} · ${n} incidente(s) abierto(s)` : base;
    },
    targetRoles: TARGET_ROLES.SUPERVISORS,
    sendEmail: false,
    emailSubject: (d) =>
      `[CGuard] ${d.guardName || 'Guardia'} inició turno${d.stationName ? ` — ${d.stationName}` : ''}`,
    emailHtml: (d) => checkinEmailHtml(d),
  },
  'guard.checkout': {
    title: (d) => `🔚 Check-out: ${d.guardName || 'Guardia'}`,
    body: (d) =>
      `${d.guardName || 'Guardia'} finalizó turno${d.siteName ? ` en ${d.siteName}` : ''}`,
    targetRoles: TARGET_ROLES.SUPERVISORS,
    sendEmail: false,
    emailSubject: (d) =>
      `[CGuard] ${d.guardName || 'Guardia'} finalizó turno${d.stationName ? ` — ${d.stationName}` : ''}`,
    emailHtml: (d) => `
      <h2>🔚 Turno finalizado</h2>
      ${d.guardName ? `<p><strong>Guardia:</strong> ${esc(d.guardName)}</p>` : ''}
      ${d.siteName ? `<p><strong>Sitio:</strong> ${esc(d.siteName)}</p>` : ''}
      ${d.stationName ? `<p><strong>Puesto:</strong> ${esc(d.stationName)}</p>` : ''}
      ${d.clockOutTime ? `<p><strong>Hora:</strong> ${esc(d.clockOutTime)}</p>` : ''}
    `,
  },
  'guard.late': {
    title: (d) => `⚠️ Guardia sin presentarse: ${d.guardName || 'Guardia'}`,
    body: (d) =>
      `${d.guardName || 'Guardia'} no ha hecho check-in${d.siteName ? ` en ${d.siteName}` : ''}${d.shiftTime ? `. Turno: ${d.shiftTime}` : ''}`,
    targetRoles: TARGET_ROLES.SUPERVISORS,
    sendEmail: true,
    emailSubject: (d) =>
      `[CGuard] Alerta: ${d.guardName || 'Guardia'} no se ha presentado`,
    emailHtml: (d) => `
      <h2>⚠️ Guardia sin presentarse</h2>
      ${d.guardName ? `<p><strong>Guardia:</strong> ${d.guardName}</p>` : ''}
      ${d.siteName ? `<p><strong>Sitio:</strong> ${d.siteName}</p>` : ''}
      ${d.shiftTime ? `<p><strong>Hora de turno:</strong> ${d.shiftTime}</p>` : ''}
    `,
  },
  'visitor.arrival': {
    title: (d) => `👤 Visitante: ${d.visitorName || 'Nuevo visitante'}`,
    body: (d) =>
      `${d.visitorName || 'Visitante'} ingresó${d.stationName ? ` en ${d.stationName}` : ''}${d.purpose ? `. Motivo: ${d.purpose}` : ''}`,
    targetRoles: TARGET_ROLES.SUPERVISORS,
    sendEmail: false,
  },
  'visitor.departure': {
    title: (d) => `👋 Salida de visitante`,
    body: (d) =>
      `${d.visitorName || 'Visitante'} salió${d.stationName ? ` de ${d.stationName}` : ''}`,
    targetRoles: TARGET_ROLES.SUPERVISORS,
    sendEmail: false,
  },
  'patrol.completed': {
    title: (d) => `✅ Ronda completada`,
    body: (d) =>
      `${d.guardName || 'Guardia'} completó ronda${d.siteName ? ` en ${d.siteName}` : ''}${d.checkpointsCount ? ` (${d.checkpointsCount} puntos)` : ''}`,
    targetRoles: TARGET_ROLES.SUPERVISORS,
    sendEmail: false,
  },
  'patrol.missed': {
    title: (d) => `⚠️ Ronda incompleta`,
    body: (d) =>
      `${d.guardName || 'Guardia'} no completó la ronda${d.siteName ? ` en ${d.siteName}` : ''}${d.missedCount ? ` (${d.missedCount} puntos perdidos)` : ''}`,
    targetRoles: TARGET_ROLES.SUPERVISORS,
    sendEmail: true,
    emailSubject: (d) =>
      `[CGuard] Ronda no completada${d.siteName ? ` en ${d.siteName}` : ''}`,
    emailHtml: (d) => `
      <h2>⚠️ Ronda no completada</h2>
      ${d.guardName ? `<p><strong>Guardia:</strong> ${d.guardName}</p>` : ''}
      ${d.siteName ? `<p><strong>Sitio:</strong> ${d.siteName}</p>` : ''}
      ${d.missedCount ? `<p><strong>Puntos perdidos:</strong> ${d.missedCount}</p>` : ''}
    `,
  },
  'shift.unassigned': {
    title: (d) => `⚠️ Turno sin asignar`,
    body: (d) =>
      `Turno sin guardia${d.siteName ? ` en ${d.siteName}` : ''}${d.shiftDate ? ` — ${d.shiftDate}` : ''}`,
    targetRoles: TARGET_ROLES.DISPATCHER,
    sendEmail: false,
  },
  'shift.exchange_requested': {
    title: (d) => `🔄 Solicitud de intercambio de turno`,
    body: (d) =>
      `${d.guardName || 'Guardia'} solicita intercambio${d.shiftDate ? ` del ${d.shiftDate}` : ''}`,
    targetRoles: TARGET_ROLES.DISPATCHER,
    sendEmail: true,
    emailSubject: (d) =>
      `[CGuard] Solicitud de cambio de turno — ${d.guardName || 'Guardia'}`,
    emailHtml: (d) => `
      <h2>Solicitud de intercambio de turno</h2>
      ${d.guardName ? `<p><strong>Guardia:</strong> ${d.guardName}</p>` : ''}
      ${d.shiftDate ? `<p><strong>Fecha de turno:</strong> ${d.shiftDate}</p>` : ''}
    `,
  },
  'shift.exchange_approved': {
    title: () => `✅ Intercambio de turno aprobado`,
    body: () => `Tu solicitud de intercambio de turno fue aprobada`,
    targetRoles: TARGET_ROLES.SPECIFIC,
    sendEmail: false,
  },
  'shift.exchange_rejected': {
    title: () => `❌ Intercambio de turno rechazado`,
    body: (d) =>
      `Tu solicitud de intercambio fue rechazada${d.reason ? `: ${d.reason}` : ''}`,
    targetRoles: TARGET_ROLES.SPECIFIC,
    sendEmail: false,
  },
  'memo.created': {
    title: (d) =>
      `📢 Memo: ${d.memoTitle || d.title || 'Nuevo memo'}`,
    body: (d) =>
      d.body
        ? d.body.slice(0, 150)
        : 'Has recibido un nuevo memo',
    // Memos are addressed to a single guard — deliver only to them, not all staff.
    targetRoles: TARGET_ROLES.SPECIFIC,
    sendEmail: true,
    emailSubject: (d) =>
      `[CGuard] Nuevo memo: ${d.memoTitle || d.title || ''}`,
    emailHtml: (d) => `
      <h2>Nuevo memo</h2>
      ${d.memoTitle || d.title ? `<h3>${d.memoTitle || d.title}</h3>` : ''}
      ${d.body ? `<p>${d.body}</p>` : ''}
    `,
  },
  'timeoff.requested': {
    title: (d) => `📅 Solicitud de días libres`,
    body: (d) =>
      `${d.guardName || d.employeeName || 'Empleado'} solicita días libres${d.dateRange ? `: ${d.dateRange}` : ''}`,
    targetRoles: TARGET_ROLES.HR,
    sendEmail: true,
    emailSubject: (d) =>
      `[CGuard] Solicitud de días libres — ${d.guardName || d.employeeName || 'Empleado'}`,
    emailHtml: (d) => `
      <h2>Solicitud de días libres</h2>
      ${d.guardName || d.employeeName ? `<p><strong>Empleado:</strong> ${d.guardName || d.employeeName}</p>` : ''}
      ${d.dateRange ? `<p><strong>Período:</strong> ${d.dateRange}</p>` : ''}
      ${d.reason ? `<p><strong>Motivo:</strong> ${d.reason}</p>` : ''}
    `,
  },
  'timeoff.approved': {
    title: () => `✅ Días libres aprobados`,
    body: (d) =>
      `Tu solicitud de días libres fue aprobada${d.dateRange ? ` para ${d.dateRange}` : ''}`,
    targetRoles: TARGET_ROLES.SPECIFIC,
    sendEmail: false,
  },
  'timeoff.rejected': {
    title: () => `❌ Días libres rechazados`,
    body: (d) =>
      `Tu solicitud fue rechazada${d.reason ? `. Motivo: ${d.reason}` : ''}`,
    targetRoles: TARGET_ROLES.SPECIFIC,
    sendEmail: false,
  },
  'task.completed': {
    title: (d) => `✅ Tarea completada: ${d.taskName || ''}`,
    body: (d) =>
      `${d.guardName || 'Guardia'} completó "${d.taskName || 'tarea'}"${d.siteName ? ` en ${d.siteName}` : ''}`,
    targetRoles: TARGET_ROLES.SUPERVISORS,
    sendEmail: false,
  },
  'task.overdue': {
    title: (d) => `⏰ Tarea vencida: ${d.taskName || ''}`,
    body: (d) =>
      `"${d.taskName || 'Tarea'}" no fue completada${d.siteName ? ` en ${d.siteName}` : ''}`,
    targetRoles: TARGET_ROLES.SUPERVISORS,
    sendEmail: true,
    emailSubject: (d) => `[CGuard] Tarea vencida: ${d.taskName || ''}`,
    emailHtml: (d) => `
      <h2>⏰ Tarea vencida</h2>
      ${d.taskName ? `<p><strong>Tarea:</strong> ${d.taskName}</p>` : ''}
      ${d.siteName ? `<p><strong>Sitio:</strong> ${d.siteName}</p>` : ''}
    `,
  },
  'dispatch.created': {
    title: (d) => `🚔 Nuevo despacho`,
    body: (d) =>
      `${d.description ? d.description.slice(0, 120) : 'Nuevo despacho'}${d.priority ? ` — Prioridad: ${d.priority}` : ''}`,
    targetRoles: TARGET_ROLES.DISPATCHER,
    sendEmail: false,
  },
};

export function getTemplate(eventType: string): NotificationTemplate | null {
  return TEMPLATES[eventType as EventType] || null;
}
