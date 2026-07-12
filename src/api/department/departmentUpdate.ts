/** @openapi { "summary": "Update department (name/description/manager/active)", "responses": { "200": { "description": "Updated department" } } } */
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
    const currentUser = SequelizeRepository.getCurrentUser(req);
    const db = req.database;
    const data = req.body?.data || req.body || {};

    const record = await db.department.findOne({
      where: { id: req.params.id, tenantId: tenant.id },
    });
    if (!record) throw new Error404();

    const patch: any = { updatedById: currentUser?.id || null };
    if (data.name !== undefined) {
      const name = String(data.name || '').trim().slice(0, 120);
      if (!name) throw new Error400(req.language, 'errors.validation.message');
      patch.name = name;
    }
    if (data.description !== undefined) {
      patch.description = data.description ? String(data.description).slice(0, 2000) : null;
    }
    if (data.managerId !== undefined) patch.managerId = data.managerId || null;
    if (data.active !== undefined) patch.active = !!data.active;

    await record.update(patch);
    await ApiResponseHandler.success(req, res, record);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
