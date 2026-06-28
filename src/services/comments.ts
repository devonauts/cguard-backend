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

async function listComments(requestId: string, tenantId: string) {
    const db = models();
    // Tenant-scoped: never resolve an incident by id alone (cross-tenant read).
    const rec = await db.incident.findOne({ where: { id: requestId, tenantId } });
    if (!rec) return [];
    return rec.comments || [];
}

async function createComment(requestId: string, tenantId: string, text: string, author: any, attachment?: any) {
  const db = models();
  const rec = await db.incident.findOne({ where: { id: requestId, tenantId } });
  if (!rec) {
    throw Object.assign(new Error('Incident not found'), { code: 404 });
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
