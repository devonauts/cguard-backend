/**
 * GET /api/tenant/:tenantId/guard/me/patrols/:assignmentId
 * Full detail of one of the guard's own patrol rounds (checkpoints + scans/photos/notes).
 */
import ApiResponseHandler from '../apiResponseHandler';
import Error401 from '../../errors/Error401';
import Error404 from '../../errors/Error404';
import { buildRondaDetail } from '../../services/rondaDetailService';

export default async (req: any, res: any) => {
  try {
    const currentUser = req.currentUser;
    if (!currentUser) throw new Error401();
    const db = req.database;
    const tenantId = req.params.tenantId || (req.currentTenant && req.currentTenant.id);
    const sg = await db.securityGuard.findOne({
      where: { guardId: currentUser.id, tenantId, deletedAt: null },
      attributes: ['id'],
    });
    if (!sg) throw new Error404();
    const detail = await buildRondaDetail(db, tenantId, req.params.assignmentId, { securityGuardId: sg.id });
    if (!detail) throw new Error404();
    await ApiResponseHandler.success(req, res, detail);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
