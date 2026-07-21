import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import Error400 from '../../errors/Error400';
import Error404 from '../../errors/Error404';
import { ingestSignal } from '../../services/alarm/normalizer';

// POST /tenant/:tenantId/alarm/manual
// Operator-initiated signal (e.g. a phoned-in alarm). Goes through the same
// normalization pipeline so it lands as a case/event like any other signal.
// Body: { alarmPanelId, category, priority, description, zoneNumber }
export default async (req, res) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.businessInfoEdit);
    const db = req.database;
    const tenantId = req.currentTenant.id;
    const body = (req.body && req.body.data) || req.body || {};

    if (!body.alarmPanelId) {
      throw new Error400(req.language, 'errors.validation.missingFields');
    }

    const panel = await db.alarmPanel.findOne({
      where: { id: body.alarmPanelId, tenantId },
    });
    if (!panel) throw new Error404();

    const sig: any = {
      alarmPanelId: panel.id,
      accountNumber: panel.accountNumber,
      zoneNumber: body.zoneNumber,
      format: 'manual',
      raw: body.description || null,
      channel: 'manual',
      // Pass the operator-supplied classification through so the normalizer can
      // honor an explicit manual category/priority/description instead of a code map.
      category: body.category,
      // Coerce: a <select> sends priority as a string ('1'). The normalizer only
      // honours a NUMBER, else defaults to 3 (media) — so a manual atraco sent as
      // '1' silently degraded from crítica to media. Number() keeps its urgency.
      priority: body.priority != null && body.priority !== '' ? Number(body.priority) : body.priority,
      description: body.description,
    };

    const result = await ingestSignal(db, tenantId, sig);

    await ApiResponseHandler.success(req, res, result);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
