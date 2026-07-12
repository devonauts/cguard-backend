/** @openapi { "summary": "Get a member's current department", "responses": { "200": { "description": "Membership department" } } } */
import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import SequelizeRepository from '../../database/repositories/sequelizeRepository';
import Error404 from '../../errors/Error404';

export default async (req, res) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.settingsRead);
    const tenant = SequelizeRepository.getCurrentTenant(req);
    const db = req.database;

    // :userId is the USER id (same convention as time-off / guard flows).
    const membership = await db.tenantUser.findOne({
      where: { tenantId: tenant.id, userId: req.params.userId },
      attributes: ['id', 'userId', 'departmentId'],
      include: [{ model: db.department, as: 'department', attributes: ['id', 'name', 'active'] }],
    });
    if (!membership) throw new Error404();

    await ApiResponseHandler.success(req, res, {
      userId: membership.userId,
      departmentId: membership.departmentId || null,
      department: membership.department
        ? { id: membership.department.id, name: membership.department.name, active: membership.department.active }
        : null,
    });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
