/**
 * POST /tenant/:tenantId/alarm/case/:id/note
 * Body: { note | detail | text }
 *
 * Append an operator note to a case's append-only audit timeline. Does not
 * change case state. Tenant-scoped; requires businessInfoEdit.
 */
import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import Error404 from '../../errors/Error404';
import Error400 from '../../errors/Error400';

export default async (req, res) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.businessInfoEdit);

    const db = req.database;
    const tenantId = req.currentTenant.id;
    const currentUser = (req as any).currentUser;
    const actorId = currentUser && currentUser.id;

    const body = req.body || {};
    const note = body.note || body.detail || body.text;
    if (!note) throw new Error400(req.language, 'alarm.noteRequired');

    const alarmCase = await db.alarmCase.findOne({
      where: { id: req.params.id, tenantId },
    });
    if (!alarmCase) throw new Error404();

    const log = await db.alarmAuditLog.create({
      alarmCaseId: alarmCase.id,
      action: 'note',
      detail: note,
      actorId: actorId || null,
      at: new Date(),
      tenantId,
    });

    const plain = typeof log.get === 'function' ? log.get({ plain: true }) : log;
    await ApiResponseHandler.success(req, res, plain);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
