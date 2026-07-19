import { Router } from 'express';
import commentsService from '../../services/comments';

export default function registerCommentsRoutes(routes: Router) {
  // List comments for a request
  routes.get('/tenant/:tenantId/request/:requestId/comments', async (req: any, res) => {
    try {
      if (!req.currentUser) return res.status(401).json({ error: 'Unauthorized' });
      const tenantId = req.currentTenant && req.currentTenant.id;
      if (!tenantId) return res.status(403).json({ error: 'Forbidden' });
      const { requestId } = req.params;
      const rows = await commentsService.listComments(requestId, tenantId);
      return res.json(rows);
    } catch (err) {
      console.error('Error listing comments', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Create comment for a request
  routes.post('/tenant/:tenantId/request/:requestId/comments', async (req: any, res) => {
    try {
      if (!req.currentUser) return res.status(401).json({ error: 'Unauthorized' });
      const tenantId = req.currentTenant && req.currentTenant.id;
      if (!tenantId) return res.status(403).json({ error: 'Forbidden' });
      const { requestId } = req.params;
      const text = (req.body && (req.body.data?.text || req.body.text)) || '';
      if (!text) return res.status(400).json({ error: 'text is required' });

      // Author comes STRICTLY from the authenticated user — never from headers
      // or the request body, which would let any caller impersonate anyone.
      const cu: any = req.currentUser;
      const userName =
        cu.fullName ||
        [cu.firstName, cu.lastName].filter(Boolean).join(' ') ||
        cu.email ||
        'Usuario';

      const attachment = (req.body && (req.body.data?.attachment || req.body.attachment)) || null;

      const author = { id: cu.id, name: userName };
      const created = await commentsService.createComment(requestId, tenantId, text, author, attachment);
      return res.status(201).json(created);
    } catch (err) {
      console.error('Error creating comment', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  });
}
