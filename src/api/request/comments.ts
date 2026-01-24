import { Router } from 'express';
import commentsService from '../../services/comments';

export default function registerCommentsRoutes(routes: Router) {
  // List comments for a request
  routes.get('/tenant/:tenantId/request/:requestId/comments', async (req, res) => {
    try {
      const { requestId } = req.params;
      const rows = await commentsService.listComments(requestId);
      return res.json(rows);
    } catch (err) {
      console.error('Error listing comments', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Create comment for a request
  routes.post('/tenant/:tenantId/request/:requestId/comments', async (req, res) => {
    try {
      const { requestId } = req.params;
      const text = (req.body && (req.body.data?.text || req.body.text)) || '';
      if (!text) return res.status(400).json({ error: 'text is required' });

      // Resolve the author: prefer authenticated `req.user`, then common headers, then body-provided author
      // authMiddleware sets `currentUser`; some code may set `user` — accept both
      const rawUser = (req as any).currentUser || (req as any).user || undefined;
      let userId = rawUser && rawUser.id ? rawUser.id : undefined;
      let userName = rawUser && (rawUser.name || rawUser.fullName || rawUser.username) ? (rawUser.name || rawUser.fullName || rawUser.username) : undefined;

      // check common headers that may carry user info
      if (!userId) userId = (req.headers['x-user-id'] as string) || (req.headers['x-uid'] as string) || undefined;
      if (!userName) userName = (req.headers['x-user-name'] as string) || (req.headers['x-username'] as string) || (req.headers['x-user'] as string) || undefined;

      // check body payload for an author field (useful for non-authenticated callers that still send author info)
      if (!userId && req.body && (req.body.data?.author || req.body.author)) {
        userId = req.body.data?.author?.id || req.body.author?.id || userId;
      }
      if (!userName && req.body && (req.body.data?.author || req.body.author)) {
        userName = req.body.data?.author?.name || req.body.author?.name || userName;
      }

      const attachment = (req.body && (req.body.data?.attachment || req.body.attachment)) || null;

      const author = { id: userId || 'system', name: userName || 'Usuario' };
      const created = await commentsService.createComment(requestId, text, author, attachment);
      return res.status(201).json(created);
    } catch (err) {
      console.error('Error creating comment', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  });
}
