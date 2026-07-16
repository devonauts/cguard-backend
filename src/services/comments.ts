import models from '../database/models';

const getId = () => {
  try {
    // prefer node crypto.randomUUID when available
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const crypto = require('crypto');
    return (crypto.randomUUID && crypto.randomUUID()) || String(Date.now());
  } catch (e) {
    return String(Date.now());
  }
};

/**
 * The CRM "Solicitudes" page is incident-backed (migration 20260323 moved the
 * request fields onto incidents), but legacy rows still live in the requests
 * table — which has its own `comments` JSON column (migration 20260123).
 * Resolve the incident first (current primary store), then fall back to the
 * request row so comments on request-table rows are not silently lost.
 * Both lookups stay tenant-scoped: never resolve by id alone.
 */
async function findCommentTarget(db: any, requestId: string, tenantId: string) {
  const incident = await db.incident.findOne({ where: { id: requestId, tenantId } });
  if (incident) return incident;
  return db.request.findOne({ where: { id: requestId, tenantId } });
}

async function listComments(requestId: string, tenantId: string) {
    const db = models();
    const rec = await findCommentTarget(db, requestId, tenantId);
    if (!rec) return [];
    return rec.comments || [];
}

async function createComment(requestId: string, tenantId: string, text: string, author: any, attachment?: any) {
  const db = models();
  const rec = await findCommentTarget(db, requestId, tenantId);
  if (!rec) {
    throw Object.assign(new Error('Request not found'), { code: 404 });
  }

  const comment = {
    id: getId(),
    text,
    createdAt: new Date().toISOString(),
    author: { id: author?.id || 'system', name: author?.name || 'Usuario' },
  };

  if (attachment) {
    comment['attachment'] = attachment;
  }

  const existing = rec.comments || [];
  const updated = [...existing, comment];
  await rec.update({ comments: updated }, { fields: ['comments'] });

  return comment;
}

export default {
  listComments,
  createComment,
};
