/** @openapi { "summary": "List departments with member counts", "responses": { "200": { "description": "rows + count" } } } */
import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import SequelizeRepository from '../../database/repositories/sequelizeRepository';

export default async (req, res) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.settingsRead);
    const tenant = SequelizeRepository.getCurrentTenant(req);
    const db = req.database;

    const where: any = { tenantId: tenant.id };
    const q = String(req.query?.filter || req.query?.q || '').trim();
    if (q) where.name = { [db.Sequelize.Op.like]: `%${q}%` };

    const rows = await db.department.findAll({
      where,
      include: [{ model: db.user, as: 'manager', attributes: ['id', 'fullName', 'firstName', 'lastName', 'email'] }],
      order: [['name', 'ASC']],
    });

    // Member counts in one grouped query (members = tenantUsers of this tenant).
    const counts = await db.tenantUser.findAll({
      where: { tenantId: tenant.id, departmentId: { [db.Sequelize.Op.ne]: null } },
      attributes: ['departmentId', [db.Sequelize.fn('COUNT', db.Sequelize.col('id')), 'members']],
      group: ['departmentId'],
      raw: true,
    });
    const byDept = new Map(counts.map((c: any) => [c.departmentId, Number(c.members)]));

    await ApiResponseHandler.success(req, res, {
      rows: rows.map((r: any) => ({
        id: r.id,
        name: r.name,
        description: r.description,
        active: r.active,
        manager: r.manager
          ? { id: r.manager.id, name: r.manager.fullName || [r.manager.firstName, r.manager.lastName].filter(Boolean).join(' ') || r.manager.email }
          : null,
        members: byDept.get(r.id) || 0,
        createdAt: r.createdAt,
      })),
      count: rows.length,
    });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
