/**
 * GET /tenant/:tenantId/guard/me/passdown/incoming
 * The unreceived pase de turno left at the guard's current post (from the previous
 * shift). Marks it received. The instruction-tasks arrive separately via /guard/me/tasks.
 */
import ApiResponseHandler from '../apiResponseHandler';
import Error401 from '../../errors/Error401';
import { getIncomingForGuard } from '../../services/shiftPassdownService';

export const guardPassdownIncoming = async (req: any, res: any) => {
  try {
    const currentUser = req.currentUser;
    if (!currentUser) throw new Error401();
    const db = req.database;
    const tenantId = req.params.tenantId || (req.currentTenant && req.currentTenant.id);
    const userId = currentUser.id;

    // Resolve the guard's current post from the open clock-in shift.
    const sg = await db.securityGuard.findOne({
      where: { guardId: userId, tenantId, deletedAt: null },
      attributes: ['id', 'fullName'],
    });
    let stationIds: string[] = [];
    let shiftId: string | null = null;
    if (sg) {
      const openShift = await db.guardShift.findOne({
        where: { guardNameId: sg.id, tenantId, punchOutTime: null },
        order: [['punchInTime', 'DESC']],
        attributes: ['id', 'stationNameId'],
      });
      if (openShift) {
        stationIds = [String(openShift.stationNameId)];
        shiftId = openShift.id;
      }
    }

    const passdown = await getIncomingForGuard(db, tenantId, userId, {
      stationIds,
      markReceived: true,
      receivedByName: sg ? sg.fullName : null,
      receivedByShiftId: shiftId,
    });
    await ApiResponseHandler.success(req, res, { passdown: passdown || null });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
