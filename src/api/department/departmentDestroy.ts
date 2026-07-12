/** @openapi { "summary": "Delete department (blocked while it has members)", "responses": { "200": { "description": "Deleted" } } } */
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

    const record = await db.department.findOne({
      where: { id: req.params.id, tenantId: tenant.id },
    });
    if (!record) throw new Error404();

    // Refuse to orphan people silently: reassign members first, then delete.
    const members = await db.tenantUser.count({
      where: { tenantId: tenant.id, departmentId: record.id },
    });
    if (members > 0) {
      throw new Error400(
        req.language,
        'errors.validation.message',
        `El departamento tiene ${members} miembro(s). Reasígnalos antes de eliminarlo.`,
      );
    }

    await record.destroy(); // paranoid → soft delete
    await ApiResponseHandler.success(req, res, { id: record.id });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
