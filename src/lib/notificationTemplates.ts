/**
 * Notification templates for platform events.
 * Maps each eventType to a title/body generator and delivery settings.
 */

export type EventType =
  | 'incident.created'
  | 'incident.updated'
  | 'panic.alert'
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
  | 'dispatch.created'
  | 'attendance.late'
  | 'attendance.no_show'
  | 'attendance.outside_geofence'
  | 'attendance.early_departure'
  | 'attendance.missed_clockout'
  | 'attendance.correction_submitted'
  | 'attendance.approval_required'
  | 'attendance.approved'
  | 'attendance.rejected'
  | 'device.mismatch';

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
  'panic.alert': {
    title: (d) => `🚨🚨 PÁNICO: ${d.stationName || 'Puesto'}`,
    body: (d) =>
      [
        d.guardName && `Guardia: ${d.guardName}`,
        d.address && `Ubicación: ${d.address}`,
        d.phone && `Tel: ${d.phone}`,
      ]
        .filter(Boolean)
        .join(' · '),
    targetRoles: TARGET_ROLES.DISPATCHER,
    sendEmail: true,
    emailSubject: (d) =>
      `[CGuard] 🚨 ALERTA DE PÁNICO — ${d.stationName || 'Puesto'}`,
    emailHtml: (d) => `
      <div style="border:3px solid #dc2626;border-radius:8px;padding:16px;font-family:sans-serif">
        <h1 style="color:#dc2626;margin:0 0 8px">🚨 ALERTA DE PÁNICO</h1>
        <p style="font-size:16px;margin:4px 0"><strong>Un guardia activó el botón de pánico.</strong></p>
        ${d.guardName ? `<p><strong>Guardia:</strong> ${esc(d.guardName)}</p>` : ''}
        ${d.stationName ? `<p><strong>Puesto:</strong> ${esc(d.stationName)}</p>` : ''}
        ${d.address ? `<p><strong>Ubicación:</strong> ${esc(d.address)}</p>` : ''}
        ${d.phone ? `<p><strong>Teléfono del sitio:</strong> ${esc(d.phone)}</p>` : ''}
        ${d.mapsUrl ? `<p><a href="${esc(d.mapsUrl)}" style="color:#dc2626">Ver ubicación en el mapa</a></p>` : ''}
        <p style="color:#dc2626;font-weight:bold;margin-top:12px">Contacte a la policía y despache un supervisor de inmediato.</p>
      </div>
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

  // ── Nómina / Time & Attendance ──────────────────────────────────────────────
  'attendance.late': {
    title: (d) => `⏰ Llegada tarde: ${d.guardName || 'Guardia'}`,
    body: (d) => `${d.guardName || 'Guardia'}${d.stationName ? ` — ${d.stationName}` : ''}. ${d.reason || ''}`.trim(),
    targetRoles: TARGET_ROLES.SUPERVISORS,
    sendEmail: true,
    emailSubject: (d) => `[CGuard] Llegada tarde: ${d.guardName || 'Guardia'}`,
    emailHtml: (d) =>
      `<h2>⏰ Llegada tarde</h2><p><strong>Guardia:</strong> ${d.guardName || ''}</p>${d.stationName ? `<p><strong>Puesto:</strong> ${d.stationName}</p>` : ''}${d.reason ? `<p>${d.reason}</p>` : ''}`,
  },
  'attendance.no_show': {
    title: (d) => `🚨 Inasistencia: ${d.guardName || 'Guardia'}`,
    body: (d) => `${d.guardName || 'Guardia'} no se presentó${d.stationName ? ` en ${d.stationName}` : ''}. ${d.reason || ''}`.trim(),
    targetRoles: TARGET_ROLES.SUPERVISORS,
    sendEmail: true,
    emailSubject: (d) => `[CGuard] Inasistencia (no-show): ${d.guardName || 'Guardia'}`,
    emailHtml: (d) =>
      `<h2>🚨 Inasistencia (no-call no-show)</h2><p><strong>Guardia:</strong> ${d.guardName || ''}</p>${d.stationName ? `<p><strong>Puesto:</strong> ${d.stationName}</p>` : ''}${d.reason ? `<p>${d.reason}</p>` : ''}`,
  },
  'attendance.outside_geofence': {
    title: (d) => `📍 Fuera de geocerca: ${d.guardName || 'Guardia'}`,
    body: (d) => `${d.guardName || 'Guardia'} marcó fuera del área${d.distanceM != null ? ` (${d.distanceM} m)` : ''}${d.stationName ? ` — ${d.stationName}` : ''}`,
    targetRoles: TARGET_ROLES.SUPERVISORS,
    sendEmail: true,
    emailSubject: (d) => `[CGuard] Marcación fuera de geocerca: ${d.guardName || 'Guardia'}`,
    emailHtml: (d) =>
      `<h2>📍 Marcación fuera de geocerca</h2><p><strong>Guardia:</strong> ${d.guardName || ''}</p>${d.stationName ? `<p><strong>Puesto:</strong> ${d.stationName}</p>` : ''}${d.distanceM != null ? `<p><strong>Distancia:</strong> ${d.distanceM} m</p>` : ''}<p>Requiere revisión del supervisor.</p>`,
  },
  'attendance.early_departure': {
    title: (d) => `🔚 Salida anticipada: ${d.guardName || 'Guardia'}`,
    body: (d) => `${d.guardName || 'Guardia'} marcó salida antes de tiempo${d.stationName ? ` — ${d.stationName}` : ''}. ${d.reason || ''}`.trim(),
    targetRoles: TARGET_ROLES.SUPERVISORS,
    sendEmail: false,
  },
  'attendance.missed_clockout': {
    title: (d) => `⚠️ Sin marcar salida: ${d.guardName || 'Guardia'}`,
    body: (d) => `${d.guardName || 'Guardia'} no marcó salida${d.stationName ? ` en ${d.stationName}` : ''}. ${d.reason || ''}`.trim(),
    targetRoles: TARGET_ROLES.SUPERVISORS,
    sendEmail: true,
    emailSubject: (d) => `[CGuard] Sin marcar salida: ${d.guardName || 'Guardia'}`,
    emailHtml: (d) =>
      `<h2>⚠️ Salida no registrada</h2><p><strong>Guardia:</strong> ${d.guardName || ''}</p>${d.stationName ? `<p><strong>Puesto:</strong> ${d.stationName}</p>` : ''}${d.reason ? `<p>${d.reason}</p>` : ''}`,
  },
  'attendance.correction_submitted': {
    title: (d) => `✏️ Corrección de asistencia solicitada`,
    body: (d) => `${d.guardName || 'Guardia'} — ${d.field || 'campo'}${d.reason ? `: ${d.reason}` : ''}`,
    targetRoles: TARGET_ROLES.SUPERVISORS,
    sendEmail: false,
  },
  'attendance.approval_required': {
    title: (d) => `🕒 Aprobación de asistencia requerida`,
    body: (d) => `${d.guardName || 'Guardia'}${d.stationName ? ` — ${d.stationName}` : ''}${d.reason ? `: ${d.reason}` : ''}`,
    targetRoles: TARGET_ROLES.SUPERVISORS,
    sendEmail: false,
  },
  'attendance.approved': {
    title: (d) => `✅ Asistencia aprobada`,
    body: (d) => `${d.guardName || 'Guardia'}${d.stationName ? ` — ${d.stationName}` : ''}`,
    targetRoles: TARGET_ROLES.SPECIFIC,
    sendEmail: false,
  },
  'attendance.rejected': {
    title: (d) => `❌ Asistencia rechazada`,
    body: (d) => `${d.guardName || 'Guardia'}${d.reason ? `: ${d.reason}` : ''}`,
    targetRoles: TARGET_ROLES.SPECIFIC,
    sendEmail: false,
  },
  'device.mismatch': {
    title: (d) => `📱 Dispositivo no reconocido: ${d.guardName || 'Guardia'}`,
    body: (d) =>
      `${d.guardName || 'Guardia'} se conectó desde un dispositivo distinto al registrado` +
      `${d.model ? ` (${d.model})` : ''}. Verifica si cambió de teléfono o si alguien más usó su cuenta.`,
    targetRoles: TARGET_ROLES.SUPERVISORS,
    sendEmail: true,
    emailSubject: (d) => `Dispositivo no reconocido — ${d.guardName || 'Guardia'}`,
    emailHtml: (d) => `
      <h2>📱 Dispositivo no reconocido</h2>
      <p><strong>Guardia:</strong> ${esc(d.guardName || 'Guardia')}</p>
      <p><strong>Dispositivo:</strong> ${esc(d.model || 'desconocido')}</p>
      <p>Este guardia inició sesión desde un dispositivo distinto al que tiene registrado.
      Si cambió de teléfono, restablece su dispositivo en el panel. Si no, podría tratarse
      del uso de su cuenta en otro equipo.</p>
    `,
  },
};

export function getTemplate(eventType: string): NotificationTemplate | null {
  return TEMPLATES[eventType as EventType] || null;
}
