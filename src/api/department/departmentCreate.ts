/** @openapi { "summary": "Create department", "responses": { "200": { "description": "Created department" } } } */
import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import SequelizeRepository from '../../database/repositories/sequelizeRepository';
import Error400 from '../../errors/Error400';

export default async (req, res) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.settingsEdit);
    const tenant = SequelizeRepository.getCurrentTenant(req);
    const currentUser = SequelizeRepository.getCurrentUser(req);
    const db = req.database;
    const data = req.body?.data || req.body || {};

    const name = String(data.name || '').trim().slice(0, 120);
    if (!name) throw new Error400(req.language, 'errors.validation.message');

    // Duplicate-name guard (case-insensitive within the tenant).
    const dupe = await db.department.findOne({
      where: db.Sequelize.where(
        db.Sequelize.fn('LOWER', db.Sequelize.col('name')),
        name.toLowerCase(),
      ),
    // eslint-disable-next-line
    } as any);
    if (dupe && dupe.tenantId === tenant.id) {
      throw new Error400(req.language, 'errors.validation.message', 'Ya existe un departamento con ese nombre.');
    }

    const record = await db.department.create({
      name,
      description: data.description ? String(data.description).slice(0, 2000) : null,
      managerId: data.managerId || null,
      active: data.active !== false,
      tenantId: tenant.id,
      createdById: currentUser?.id || null,
      updatedById: currentUser?.id || null,
    });

    await ApiResponseHandler.success(req, res, record);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
