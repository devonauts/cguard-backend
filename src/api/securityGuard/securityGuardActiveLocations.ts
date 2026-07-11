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
      // Only the fields the map consumes — a bare findAll would hydrate every
      // open shift's TEXT blobs (selfie, sessions JSON, checklist) on a poll
      // that every open dashboard hits every few seconds.
      attributes: [
        'id',
        'guardNameId',
        'punchInLatitude',
        'punchInLongitude',
        'punchInTime',
        // Live telemetry (guardMeLocation ping) — preferred over the static
        // clock-in snapshot so the map tracks the guard, not the punch-in spot.
        'liveLatitude',
        'liveLongitude',
        'liveLocationAt',
      ],
      include: [
        {
          model: db.securityGuard,
          as: 'guardName',
          // Do not request association 'profileImage' as an attribute (it's a relation, not a DB column)
          attributes: ['id', 'fullName', 'guardId', 'isOnDuty'],
        },
      ],
      order: [['punchInTime', 'DESC']],
      limit: 1000,
    });

    const rows = (openShifts || []).map((r) => {
      const plain = r.get({ plain: true });
      const guard = plain.guardName || null;
      // Prefer the live GPS ping (continuously refreshed by the worker app's
      // guardMeLocation) over the clock-in snapshot, which is static for the
      // whole shift. Fall back to punch-in coords when the guard hasn't pinged
      // yet. Field names are unchanged (consumers read latitude/longitude and
      // show punchInTime as "last seen"), only the values get fresher — so the
      // timestamp follows the coordinate source to keep "last seen" truthful.
      const hasLive = plain.liveLatitude != null && plain.liveLongitude != null;
      return {
        guardShiftId: plain.id,
        guardId: guard ? guard.id : null,
        userId: guard ? guard.guardId : null,
        fullName: guard ? guard.fullName : null,
        isOnDuty: guard ? guard.isOnDuty : null,
        latitude: hasLive ? plain.liveLatitude : plain.punchInLatitude || null,
        longitude: hasLive ? plain.liveLongitude : plain.punchInLongitude || null,
        punchInTime:
          (hasLive && plain.liveLocationAt) || plain.punchInTime || null,
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
      attributes: ['id', 'fullName', 'guardId', 'isOnDuty'],
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
