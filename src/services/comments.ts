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
  const req = await db.request.findByPk(requestId);
  if (!req) return [];
  return req.comments || [];
}

async function createComment(requestId: string, text: string, author: any, attachment?: any) {
  const db = models();
  const req = await db.request.findByPk(requestId);
  if (!req) {
    throw new Error('Request not found');
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

  const existing = req.comments || [];
  const updated = [...existing, comment];
  await req.update({ comments: updated }, { fields: ['comments'] });

  return comment;
}

export default {
  listComments,
  createComment,
};
