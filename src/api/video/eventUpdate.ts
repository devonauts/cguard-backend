import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import Error404 from '../../errors/Error404';

// PATCH /tenant/:tenantId/video/event/:id  (ack/resolve)
export default async (req, res) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.businessInfoEdit);
    const db = req.database;
    const tenantId = req.currentTenant.id;
    const currentUser = (req as any).currentUser;
    const body = req.body || {};

    const event = await db.videoEvent.findOne({
      where: { id: req.params.id, tenantId },
    });
    if (!event) throw new Error404();

    const updates: any = {};
    if (typeof body.status !== 'undefined') {
      updates.status = body.status;
      if ((body.status === 'ack' || body.status === 'resolved') && currentUser) {
        updates.acknowledgedById = currentUser.id;
      }
    }
    if (typeof body.severity !== 'undefined') updates.severity = body.severity;
    if (typeof body.title !== 'undefined') updates.title = body.title;
    if (typeof body.description !== 'undefined') updates.description = body.description;

    await event.update(updates);
    const plain = typeof event.get === 'function' ? event.get({ plain: true }) : event;

    await ApiResponseHandler.success(req, res, plain);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
