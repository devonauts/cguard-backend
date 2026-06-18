/**
 * SuperAdmin · notification center routes. Mounted under /api/superadmin behind
 * requireSuperadmin. Full CRUD over platform notifications.
 *
 *   GET    /notifications                 — list (filters: isRead, type, search, page, limit)
 *   GET    /notifications/unread-count     — { unread }
 *   PATCH  /notifications/:id/read         — mark one read/unread ({ isRead?: boolean })
 *   POST   /notifications/read-all         — mark all read
 *   DELETE /notifications/:id              — delete one
 *   DELETE /notifications                  — clear all (or ?onlyRead=true)
 */
import ApiResponseHandler from '../apiResponseHandler';
import { db } from '../../services/superadmin/superadminHelpers';
import {
  listNotifications,
  getUnreadCount,
  markRead,
  markAllRead,
  removeNotification,
  clearAll,
} from '../../services/superadmin/superadminNotificationService';

export default (router) => {
  router.get('/notifications', async (req, res) => {
    try {
      const q = req.query || {};
      const isRead =
        q.isRead === 'true' ? true : q.isRead === 'false' ? false : undefined;
      const payload = await listNotifications(db(req), {
        page: q.page ? parseInt(String(q.page), 10) : 1,
        limit: q.limit ? parseInt(String(q.limit), 10) : 25,
        isRead,
        type: q.type ? String(q.type) : undefined,
        search: q.search ? String(q.search) : undefined,
      });
      await ApiResponseHandler.success(req, res, payload);
    } catch (error) {
      await ApiResponseHandler.error(req, res, error);
    }
  });

  router.get('/notifications/unread-count', async (req, res) => {
    try {
      await ApiResponseHandler.success(req, res, await getUnreadCount(db(req)));
    } catch (error) {
      await ApiResponseHandler.error(req, res, error);
    }
  });

  router.patch('/notifications/:id/read', async (req, res) => {
    try {
      const isRead = req.body && req.body.isRead === false ? false : true;
      const row = await markRead(db(req), req.params.id, isRead);
      if (!row) return ApiResponseHandler.error(req, res, { code: 404, message: 'Not found' });
      await ApiResponseHandler.success(req, res, row);
    } catch (error) {
      await ApiResponseHandler.error(req, res, error);
    }
  });

  router.post('/notifications/read-all', async (req, res) => {
    try {
      await ApiResponseHandler.success(req, res, await markAllRead(db(req)));
    } catch (error) {
      await ApiResponseHandler.error(req, res, error);
    }
  });

  router.delete('/notifications/:id', async (req, res) => {
    try {
      await ApiResponseHandler.success(req, res, await removeNotification(db(req), req.params.id));
    } catch (error) {
      await ApiResponseHandler.error(req, res, error);
    }
  });

  router.delete('/notifications', async (req, res) => {
    try {
      const onlyRead = String((req.query || {}).onlyRead) === 'true';
      await ApiResponseHandler.success(req, res, await clearAll(db(req), onlyRead));
    } catch (error) {
      await ApiResponseHandler.error(req, res, error);
    }
  });
};
