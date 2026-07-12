/** @openapi { "summary": "Assign or unassign a member's department", "requestBody": { "content": { "application/json": { "schema": { "type": "object", "properties": { "departmentId": { "type": "string", "nullable": true } } } } } }, "responses": { "200": { "description": "Updated membership" } } } */
import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import SequelizeRepository from '../../database/repositories/sequelizeRepository';
import Error400 from '../../errors/Error400';
import Error404 from '../../errors/Error404';

export default async (req, res) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.settingsEdit);
    const tenant = SequelizeRepository.getCurrentTenant(req);
    const db = req.database;
    const data = req.body?.data || req.body || {};
    const departmentId = data.departmentId || null;

    // :userId is the USER id (same convention as time-off / guard flows).
    const membership = await db.tenantUser.findOne({
      where: { tenantId: tenant.id, userId: req.params.userId },
    });
    if (!membership) throw new Error404();

    if (departmentId) {
      const dept = await db.department.findOne({
        where: { id: departmentId, tenantId: tenant.id, active: true },
      });
      if (!dept) {
        throw new Error400(req.language, 'errors.validation.message', 'Departamento inválido o inactivo.');
      }
    }

    await membership.update({ departmentId });
    await ApiResponseHandler.success(req, res, {
      userId: req.params.userId,
      departmentId,
    });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
