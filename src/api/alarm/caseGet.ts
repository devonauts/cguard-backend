/**
 * GET /tenant/:tenantId/alarm/case/:id
 *
 * Fetch a single alarm case with its events, panel, dispatches and the
 * append-only audit timeline. Tenant-scoped; requires businessInfoRead.
 */
import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import Error404 from '../../errors/Error404';

export default async (req, res) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.businessInfoRead);

    const db = req.database;
    const tenantId = req.currentTenant.id;

    const alarmCase = await db.alarmCase.findOne({
      where: { id: req.params.id, tenantId },
      include: [
        { model: db.alarmPanel, as: 'panel', required: false },
        {
          model: db.alarmEvent,
          as: 'events',
          required: false,
          separate: true,
          order: [['at', 'ASC']],
        },
        {
          model: db.alarmDispatch,
          as: 'dispatches',
          required: false,
          separate: true,
          order: [['createdAt', 'ASC']],
        },
        {
          model: db.alarmAuditLog,
          as: 'auditLogs',
          required: false,
          separate: true,
          order: [['at', 'ASC']],
        },
      ],
    });

    if (!alarmCase) throw new Error404();

    const plain =
      typeof alarmCase.get === 'function'
        ? alarmCase.get({ plain: true })
        : alarmCase;

    // Strip the AES key from any included panel — never returned by the API.
    if (plain && plain.panel) {
      delete plain.panel.dc09Key;
    }

    // ECV call log (attached without an association to keep the model lean).
    const calls = await db.alarmCallLog.findAll({
      where: { alarmCaseId: alarmCase.id, tenantId },
      order: [['at', 'ASC']],
    });
    plain.calls = (calls || []).map((c: any) => (typeof c.get === 'function' ? c.get({ plain: true }) : c));

    await ApiResponseHandler.success(req, res, plain);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
