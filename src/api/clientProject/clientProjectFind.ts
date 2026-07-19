import PermissionChecker from '../../services/user/permissionChecker';
import Permissions from '../../security/permissions';
import ApiResponseHandler from '../apiResponseHandler';

export default async (req, res) => {
  try {
    new PermissionChecker(req).validateHas(
      Permissions.values.clientAccountRead,
    );
    const { tenantId, id } = req.params;
    const db = req.database;

    const project = await db.clientProject.findOne({
      where: { id, tenantId },
      include: [
        {
          model: db.clientAccount,
          as: 'clientAccount',
          attributes: ['id', 'name', 'lastName'],
          required: false,
        },
      ],
    });

    if (!project) {
      return res.status(404).json({ message: 'Project not found' });
    }

    return res.json(project);
  } catch (err: any) {
    console.error('clientProjectFind error:', err);
    return ApiResponseHandler.error(req, res, err);
  }
};
