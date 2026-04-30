import { Op } from 'sequelize';

export default async (req, res) => {
  try {
    const { tenantId, id } = req.params;
    const {
      limit = 25,
      offset = 0,
      filter = {},
    } = req.query as any;

    const clientAccountId = id || filter.clientAccountId;

    const where: any = { tenantId };
    if (clientAccountId) where.clientAccountId = clientAccountId;
    if (filter.type) where.type = filter.type;
    if (filter.status) where.status = filter.status;
    if (filter.name) {
      where.name = { [Op.like]: `%${filter.name}%` };
    }

    const db = req.database;
    const { rows, count } = await db.clientProject.findAndCountAll({
      where,
      limit: parseInt(limit),
      offset: parseInt(offset),
      order: [['createdAt', 'DESC']],
      include: [
        {
          model: db.clientAccount,
          as: 'clientAccount',
          attributes: ['id', 'name', 'lastName', 'commercialName'],
          required: false,
        },
      ],
    });

    return res.json({ rows, count });
  } catch (err: any) {
    console.error('clientProjectList error:', err);
    return res.status(500).json({ message: err.message || 'Error listing projects' });
  }
};
