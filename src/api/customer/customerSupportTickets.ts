/**
 * Client-app in-app support ticketing (Mi Seguridad). Auth = the customer JWT
 * (currentUser.clientAccountId). Replaces the app's hardcoded mailto: with real,
 * CRM-visible tickets that carry a status and a reply thread.
 *
 *   POST /customer/support-tickets              { subject, message, category? } → { success, ticketId }
 *   GET  /customer/support-tickets              the client's own tickets → { rows, count }
 *   GET  /customer/support-tickets/:id          the ticket + reply thread
 *   POST /customer/support-tickets/:id/reply    { message } → append a reply
 *
 * Backed by a small dedicated store (see services/supportTicketService.ts) because
 * the `inquiries` model can't represent status/client-scope/threads. Every read is
 * scoped to tenantId + the JWT's clientAccountId. CRM notify is best-effort
 * (storePlatformEvent → supervisors) and never fails the request.
 */
import ApiResponseHandler from '../apiResponseHandler';
import Error401 from '../../errors/Error401';
import Error400 from '../../errors/Error400';
import { storePlatformEvent } from '../../lib/platformEventStore';
import { TARGET_ROLES } from '../../lib/notificationTemplates';
import {
  createTicket,
  listTickets,
  getTicket,
  listReplies,
  addReply,
} from '../../services/supportTicketService';

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

/** Resolve a friendly client name for CRM notifications (best-effort). */
async function clientNameOf(db: any, clientAccountId: string): Promise<string> {
  try {
    const ca = await db.clientAccount.findByPk(clientAccountId, {
      attributes: ['name', 'lastName', 'commercialName'],
    });
    if (ca) {
      return (
        ca.commercialName ||
        [ca.name, ca.lastName].filter(Boolean).join(' ').trim() ||
        'el cliente'
      );
    }
  } catch {
    /* non-fatal */
  }
  return 'el cliente';
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /customer/support-tickets
// ─────────────────────────────────────────────────────────────────────────────
export const customerSupportTicketCreate = async (req: any, res: any) => {
  try {
    const { db, tenantId, userId, clientAccountId } = customerCtx(req);
    const b = req.body?.data || req.body || {};

    const subject = String(b.subject || '').trim().slice(0, 255);
    const message = String(b.message || b.content || '').trim();
    const category = b.category ? String(b.category).trim().slice(0, 80) : null;
    if (!subject) throw new Error('Asunto requerido (subject)');
    if (!message) throw new Error('Mensaje requerido (message)');

    const ticketId = await createTicket(db, {
      tenantId,
      clientAccountId,
      userId,
      subject,
      message,
      category,
    });

    // ── CRM notify (in-app, supervisors). Best-effort.
    try {
      const clientName = await clientNameOf(db, clientAccountId);
      await storePlatformEvent(db, {
        tenantId,
        eventType: 'support.ticket.created',
        title: `🎫 Nuevo ticket de soporte: ${subject}`,
        body: `${clientName}: ${message.slice(0, 200)}`,
        payload: { ticketId, subject, category, clientAccountId },
        targetRoles: TARGET_ROLES.SUPERVISORS,
        sourceEntityType: 'supportTicket',
        sourceEntityId: ticketId,
      });
    } catch {
      /* never fail the create on notify */
    }

    return ApiResponseHandler.success(req, res, { success: true, ticketId });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /customer/support-tickets
// ─────────────────────────────────────────────────────────────────────────────
export const customerSupportTicketList = async (req: any, res: any) => {
  try {
    const { db, tenantId, clientAccountId } = customerCtx(req);
    const limit = Math.min(parseInt((req.query || {}).limit, 10) || 100, 200);
    const { rows, count } = await listTickets(db, tenantId, clientAccountId, limit);
    return ApiResponseHandler.success(req, res, { rows, count });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /customer/support-tickets/:id
// ─────────────────────────────────────────────────────────────────────────────
export const customerSupportTicketGet = async (req: any, res: any) => {
  try {
    const { db, tenantId, clientAccountId } = customerCtx(req);
    const ticket = await getTicket(db, tenantId, clientAccountId, String(req.params.id));
    if (!ticket) return ApiResponseHandler.error(req, res, new Error('Ticket no encontrado'));
    const replies = await listReplies(db, tenantId, ticket.id);
    return ApiResponseHandler.success(req, res, { ticket, replies });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /customer/support-tickets/:id/reply
// ─────────────────────────────────────────────────────────────────────────────
export const customerSupportTicketReply = async (req: any, res: any) => {
  try {
    const { db, tenantId, userId, clientAccountId } = customerCtx(req);
    const b = req.body?.data || req.body || {};
    const message = String(b.message || b.content || '').trim();
    if (!message) throw new Error('Mensaje requerido (message)');

    // Ownership: the ticket must belong to this client (scoped read).
    const ticket = await getTicket(db, tenantId, clientAccountId, String(req.params.id));
    if (!ticket) return ApiResponseHandler.error(req, res, new Error('Ticket no encontrado'));

    const replyId = await addReply(db, {
      tenantId,
      ticketId: ticket.id,
      authorType: 'client',
      authorId: userId,
      message,
    });

    // ── CRM notify (in-app, supervisors). Best-effort.
    try {
      const clientName = await clientNameOf(db, clientAccountId);
      await storePlatformEvent(db, {
        tenantId,
        eventType: 'support.ticket.reply',
        title: `💬 Respuesta en ticket: ${ticket.subject}`,
        body: `${clientName}: ${message.slice(0, 200)}`,
        payload: { ticketId: ticket.id, replyId, subject: ticket.subject, clientAccountId },
        targetRoles: TARGET_ROLES.SUPERVISORS,
        sourceEntityType: 'supportTicket',
        sourceEntityId: ticket.id,
      });
    } catch {
      /* never fail the reply on notify */
    }

    return ApiResponseHandler.success(req, res, { success: true, replyId });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
