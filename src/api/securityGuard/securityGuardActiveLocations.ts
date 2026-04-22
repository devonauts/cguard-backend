import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';

export default async (req, res, next) => {
  try {
    // Require read permission for guard shifts (dashboard users should have read access)
    new PermissionChecker(req).validateHas(
      Permissions.values.guardShiftRead,
    );

    const db = req.database;
    const tenantId = req.currentTenant && req.currentTenant.id;

    // Find open guard shifts (punchOutTime IS NULL) and include the related securityGuard
    const openShifts = await db.guardShift.findAll({
      where: {
        tenantId,
        punchOutTime: null,
      },
      include: [
        {
          model: db.securityGuard,
          as: 'guardName',
          attributes: ['id', 'fullName', 'guardId', 'profileImage', 'isOnDuty'],
        },
      ],
      order: [['punchInTime', 'DESC']],
      limit: 1000,
    });

    const rows = (openShifts || []).map((r) => {
      const plain = r.get({ plain: true });
      const guard = plain.guardName || null;
      return {
        guardShiftId: plain.id,
        guardId: guard ? guard.id : null,
        userId: guard ? guard.guardId : null,
        fullName: guard ? guard.fullName : null,
        isOnDuty: guard ? guard.isOnDuty : null,
        latitude: plain.punchInLatitude || null,
        longitude: plain.punchInLongitude || null,
        punchInTime: plain.punchInTime || null,
      };
    });

    // Also include guards that have isOnDuty=true but no open shift (fallback)
    const guardIdsSeen = rows.map((r) => r.guardId).filter(Boolean);
    const fallbackGuards = await db.securityGuard.findAll({
      where: {
        tenantId,
        isOnDuty: true,
        id: {
          [db.Sequelize.Op.notIn]: guardIdsSeen.length ? guardIdsSeen : [null],
        },
      },
      attributes: ['id', 'fullName', 'guardId', 'profileImage', 'isOnDuty'],
      limit: 1000,
    });

    const fallbackRows = (fallbackGuards || []).map((g) => ({
      guardShiftId: null,
      guardId: g.id,
      userId: g.guardId,
      fullName: g.fullName,
      isOnDuty: g.isOnDuty,
      latitude: null,
      longitude: null,
      punchInTime: null,
    }));

    const payload = {
      rows: [...rows, ...fallbackRows],
      count: rows.length + fallbackRows.length,
    };

    await ApiResponseHandler.success(req, res, payload);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
