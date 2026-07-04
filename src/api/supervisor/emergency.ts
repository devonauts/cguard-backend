import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';

/**
 * Emergency contacts for the supervisor SOS screen: the tenant dispatch line,
 * the current supervisor, and the on-duty guard group (count + a reachable
 * number). Gated `supervisorMe`.
 *
 * GET /tenant/:tenantId/supervisor/me/emergency
 */
export const getEmergency = async (req: any, res: any) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.supervisorMe);
    const db = req.database;
    const tenantId = req.currentTenant.id;
    const me = req.currentUser;

    const tenant = await db.tenant.findByPk(tenantId, { attributes: ['id', 'name', 'phone'] }).catch(() => null);

    // On-duty guards = open attendance shifts (not punched out).
    let onDutyCount = 0;
    let onDutyPhone: string | null = null;
    try {
      const openShifts = await db.guardShift.findAll({
        where: { tenantId, punchOutTime: null },
        attributes: ['guardNameId'],
      });
      const ids = [...new Set(openShifts.map((s: any) => String(s.guardNameId)).filter(Boolean))];
      onDutyCount = ids.length;
      if (ids.length) {
        const users = await db.user.findAll({
          where: { id: { [db.Sequelize.Op.in]: ids } },
          attributes: ['id', 'phoneNumber'],
        });
        onDutyPhone = (users.find((u: any) => u.phoneNumber) || {}).phoneNumber || null;
      }
    } catch { /* best-effort */ }

    const meName = `${me.firstName || ''} ${me.lastName || ''}`.trim() || me.email;

    await ApiResponseHandler.success(req, res, {
      dispatch: {
        name: 'Central de Despacho',
        subtitle: 'Monitoreo 24/7',
        phone: (tenant && tenant.phone) || null,
      },
      supervisor: {
        name: meName,
        subtitle: 'En servicio',
        phone: me.phoneNumber || null,
      },
      onDutyGuards: {
        name: 'Vigilantes en servicio',
        count: onDutyCount,
        phone: onDutyPhone,
      },
    });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};

export default getEmergency;
