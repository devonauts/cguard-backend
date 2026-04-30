const PROJECT_TYPES = ['event', 'investigation', 'alarm_response', 'consulting', 'other'];
const PROJECT_STATUSES = ['active', 'completed', 'cancelled', 'on_hold'];

export default async (req, res) => {
  try {
    const { tenantId, id } = req.params;
    const body = req.body || {};
    const db = req.database;

    const project = await db.clientProject.findOne({ where: { id, tenantId } });
    if (!project) {
      return res.status(404).json({ message: 'Project not found' });
    }

    const updates: any = {};
    if (body.name !== undefined) {
      updates.name = String(body.name).trim();
      if (!updates.name) return res.status(422).json({ message: 'name cannot be empty' });
    }
    if (body.type !== undefined) {
      if (!PROJECT_TYPES.includes(body.type)) {
        return res.status(422).json({ message: `type must be one of: ${PROJECT_TYPES.join(', ')}` });
      }
      updates.type = body.type;
    }
    if (body.description !== undefined) updates.description = body.description || null;
    if (body.status !== undefined) {
      if (!PROJECT_STATUSES.includes(body.status)) {
        return res.status(422).json({ message: `status must be one of: ${PROJECT_STATUSES.join(', ')}` });
      }
      updates.status = body.status;
    }
    if (body.startDate !== undefined) updates.startDate = body.startDate || null;
    if (body.endDate !== undefined) updates.endDate = body.endDate || null;
    if (body.location !== undefined) updates.location = body.location || null;
    if (body.estimatedHours !== undefined) updates.estimatedHours = body.estimatedHours ? parseFloat(body.estimatedHours) : null;
    if (body.assignedGuards !== undefined) updates.assignedGuards = Array.isArray(body.assignedGuards) ? body.assignedGuards : [];
    if (body.notes !== undefined) updates.notes = body.notes || null;
    if (body.businessInfoId !== undefined || body.siteId !== undefined) {
      updates.businessInfoId = body.businessInfoId || body.siteId || null;
    }
    if (body.clientAccountId !== undefined || body.clientId !== undefined) {
      updates.clientAccountId = body.clientAccountId || body.clientId;
    }

    await project.update(updates);
    return res.json(project);
  } catch (err: any) {
    console.error('clientProjectUpdate error:', err);
    return res.status(500).json({ message: err.message || 'Error updating project' });
  }
};
