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

    // Duplicate-name guard (case-insensitive within the tenant). The probe is
    // tenant-scoped in the query itself — an unscoped LOWER(name) lookup used to
    // return a same-named row from ANOTHER tenant first and let the own-tenant
    // duplicate slip through.
    // Plain tenant-scoped equality: the column's utf8mb4_unicode_ci collation
    // makes it case-insensitive on MySQL, and the query stays indexed (the old
    // LOWER(name) probe was unscoped AND unindexable; a findAll rewrite loaded
    // the whole tenant's departments).
    const dupe = await db.department.findOne({
      where: { tenantId: tenant.id, name },
      attributes: ['id'],
    });
    if (dupe) {
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
