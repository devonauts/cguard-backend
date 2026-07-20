/**
 * Client-app service / extra-guard requests (Mi Seguridad). Auth = the customer
 * JWT (currentUser.clientAccountId). REUSES the existing `request` model (the CRM
 * "Solicitudes" inbox the ops team reads), so a customer request lands exactly
 * where the company already triages requests.
 *
 *   POST /customer/service-requests   create a request → CRM (in-app to supervisors)
 *   GET  /customer/service-requests   the client's own requests with status
 *
 * Body (POST):
 *   { type?: 'extra_guard'|'service'|'quote', subject, message,
 *     stationId?, requestedDate? }
 *
 * The request `action` column is the CRM workflow enum (defaults to "Recibido").
 * `status` is abierto|cerrado. The request `type` + requestedDate are recorded in
 * the `comments` JSON (no dedicated column) so the CRM sees the category.
 *
 * CRM notify is best-effort (try/catch) via the same in-app platform-event channel
 * the dispatcher uses (storePlatformEvent → CRM Panel de control), targeted at
 * supervisors. Never fails the create.
 */
import { Op } from 'sequelize';
import businessNameOf, { CLIENT_LABEL_ATTRIBUTES } from '../../services/clientDisplayName';
import ApiResponseHandler from '../apiResponseHandler';
import Error401 from '../../errors/Error401';
import Error400 from '../../errors/Error400';
import { storePlatformEvent } from '../../lib/platformEventStore';
import { TARGET_ROLES } from '../../lib/notificationTemplates';

const VALID_TYPES = ['extra_guard', 'service', 'quote'];

const customerCtx = (req: any) => {
  const u = req.currentUser;
  if (!u) throw new Error401();
  const clientAccountId = u.clientAccountId;
  if (!clientAccountId) throw new Error400(req.language, 'auth.clientAccountNotFound');
  return {
    db: req.database,
    tenantId: u.tenantId || (req.currentTenant && req.currentTenant.id),
    userId: u.id,
    clientAccountId,
  };
};

/** Stations owned by this client (mirrors customerSafety.resolveCustomerStations). */
async function resolveCustomerStationIds(db: any, tenantId: string, clientAccountId: string): Promise<Set<string>> {
  const ids = new Set<string>();
  const [originStations, postSites] = await Promise.all([
    db.station.findAll({
      where: { ...(tenantId ? { tenantId } : {}), stationOriginId: clientAccountId, deletedAt: null },
      attributes: ['id'],
    }),
    db.businessInfo.findAll({
      where: { ...(tenantId ? { tenantId } : {}), clientAccountId, deletedAt: null },
      attributes: ['id'],
    }),
  ]);
  for (const s of originStations || []) ids.add(String(s.id));
  const postSiteIds = (postSites || []).map((b: any) => String(b.id));
  if (postSiteIds.length) {
    const psStations = await db.station.findAll({
      where: { ...(tenantId ? { tenantId } : {}), postSiteId: { [Op.in]: postSiteIds }, deletedAt: null },
      attributes: ['id'],
    });
    for (const s of psStations || []) ids.add(String(s.id));
  }
  return ids;
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /customer/service-requests
// ─────────────────────────────────────────────────────────────────────────────
export const customerServiceRequestCreate = async (req: any, res: any) => {
  try {
    const { db, tenantId, userId, clientAccountId } = customerCtx(req);
    const b = req.body?.data || req.body || {};

    const subject = String(b.subject || '').trim();
    const message = String(b.message || b.content || '').trim();
    if (!subject) throw new Error('Asunto requerido (subject)');
    if (!message) throw new Error('Mensaje requerido (message)');

    const type = VALID_TYPES.includes(String(b.type)) ? String(b.type) : 'service';
    const requestedDate = b.requestedDate ? new Date(b.requestedDate) : null;
    const validRequestedDate = requestedDate && !isNaN(requestedDate.getTime()) ? requestedDate : null;

    // Validate an explicit stationId belongs to the client (else drop it; the CRM
    // can assign one). Never block the request on a bad station.
    let stationId: string | null = b.stationId ? String(b.stationId) : null;
    if (stationId) {
      const myStationIds = await resolveCustomerStationIds(db, tenantId, clientAccountId);
      if (!myStationIds.has(stationId)) stationId = null;
    }

    let clientName = 'el cliente';
    try {
      const ca = await db.clientAccount.findByPk(clientAccountId, { attributes: CLIENT_LABEL_ATTRIBUTES });
      // Un SOS/incidente llega rotulado "Cliente: X" al CRM y al vigilante — X debe
      // ser la empresa, que es como el operador reconoce de dónde viene la alerta.
      if (ca) clientName = businessNameOf(ca) || clientName;
    } catch { /* non-fatal */ }

    // request model REAL columns: subject, content, status (abierto|cerrado),
    // action (CRM workflow enum → "Recibido"), callerType, callerName, clientId,
    // stationId, dateTime. The request type + requestedDate go in comments (JSON).
    const request = await db.request.create({
      dateTime: new Date(),
      subject,
      content: message,
      status: 'abierto',
      action: 'Recibido',
      callerType: 'client',
      callerName: clientName,
      priority: 'media',
      clientId: clientAccountId,
      stationId,
      comments: [
        {
          type,
          requestedDate: validRequestedDate ? validRequestedDate.toISOString() : null,
          by: 'client',
          clientAccountId,
          at: new Date().toISOString(),
        },
      ],
      tenantId,
      createdById: userId,
      updatedById: userId,
    });
    const requestId = String(request.id);

    // ── CRM notify (in-app, supervisors). Best-effort.
    try {
      const typeLabel =
        type === 'extra_guard' ? 'Guardia adicional' : type === 'quote' ? 'Cotización' : 'Servicio';
      await storePlatformEvent(db, {
        tenantId,
        eventType: 'request.created',
        title: `📨 Nueva solicitud de cliente: ${typeLabel}`,
        body: `${clientName}: ${subject}`,
        payload: { requestId, type, subject, stationId: stationId || null },
        targetRoles: TARGET_ROLES.SUPERVISORS,
        sourceEntityType: 'request',
        sourceEntityId: requestId,
      });
    } catch { /* never fail the request on notify */ }

    return ApiResponseHandler.success(req, res, { success: true, requestId });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /customer/service-requests
// ─────────────────────────────────────────────────────────────────────────────
export const customerServiceRequestList = async (req: any, res: any) => {
  try {
    const { db, tenantId, clientAccountId } = customerCtx(req);
    const limit = Math.min(parseInt((req.query || {}).limit, 10) || 100, 200);

    const rows = await db.request.findAll({
      where: { ...(tenantId ? { tenantId } : {}), clientId: clientAccountId, deletedAt: null },
      include: [{ model: db.station, as: 'station', attributes: ['id', 'stationName'] }],
      order: [['createdAt', 'DESC']],
      limit,
    });

    const out = (rows || []).map((r: any) => {
      const plain = r.get({ plain: true });
      let meta: any = {};
      try {
        const c = Array.isArray(plain.comments) ? plain.comments[0] : null;
        if (c) meta = c;
      } catch { /* ignore */ }
      return {
        id: plain.id,
        type: meta.type || null,
        subject: plain.subject || null,
        message: plain.content || null,
        status: plain.status || null,
        action: plain.action || null,
        requestedDate: meta.requestedDate || null,
        stationId: plain.stationId || null,
        stationName: plain.station ? plain.station.stationName : null,
        createdAt: plain.createdAt || null,
      };
    });

    return ApiResponseHandler.success(req, res, { rows: out, count: out.length });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
