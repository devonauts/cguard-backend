export default async (req, res) => {
  try {
    const { tenantId, id } = req.params;
    const db = req.database;

    const project = await db.clientProject.findOne({
      where: { id, tenantId },
      include: [
        {
          model: db.clientAccount,
          as: 'clientAccount',
          attributes: ['id', 'name', 'lastName', 'commercialName'],
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
    return res.status(500).json({ message: err.message || 'Error finding project' });
  }
};
