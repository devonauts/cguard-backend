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

async function listComments(requestId: string) {
    const db = models();
    const rec = await db.incident.findByPk(requestId);
    if (!rec) return [];
    return rec.comments || [];
}

async function createComment(requestId: string, text: string, author: any, attachment?: any) {
  const db = models();
  const rec = await db.incident.findByPk(requestId);
  if (!rec) {
    throw new Error('Incident not found');
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
