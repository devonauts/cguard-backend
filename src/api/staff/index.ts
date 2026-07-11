import { getStatus, clockIn, clockOut, breakStart, breakEnd } from './clock';

/**
 * Staff self-attendance routes — the CRM web time clock for administrative /
 * office users (no securityGuard row, no station). Writes staffShift rows,
 * folded into Nómina › Registros de Asistencia.
 */
export default (app) => {
  app.get('/tenant/:tenantId/staff/me', getStatus);
  app.post('/tenant/:tenantId/staff/me/clock-in', clockIn);
  app.post('/tenant/:tenantId/staff/me/clock-out', clockOut);
  app.post('/tenant/:tenantId/staff/me/break/start', breakStart);
  app.post('/tenant/:tenantId/staff/me/break/end', breakEnd);
};
