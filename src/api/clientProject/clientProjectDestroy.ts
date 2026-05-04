export default async (req, res) => {
  try {
    const { tenantId } = req.params;
    const body = req.body || {};
    const ids: string[] = Array.isArray(body.ids) ? body.ids : (body.id ? [body.id] : []);

    if (ids.length === 0) {
      return res.status(422).json({ message: 'ids is required' });
    }

    const db = req.database;

    await db.clientProject.destroy({
      where: { id: ids, tenantId },
    });

    return res.json({ message: 'Deleted', count: ids.length });
  } catch (err: any) {
    console.error('clientProjectDestroy error:', err);
    return res.status(500).json({ message: err.message || 'Error deleting projects' });
  }
};
