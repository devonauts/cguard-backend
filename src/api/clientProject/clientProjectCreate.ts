import { v4 as uuidv4 } from 'uuid';

const PROJECT_TYPES = ['event', 'investigation', 'alarm_response', 'consulting', 'other'];
const PROJECT_STATUSES = ['active', 'completed', 'cancelled', 'on_hold'];

export default async (req, res) => {
  try {
    const { tenantId } = req.params;
    const body = req.body || {};

    const name = (body.name || '').trim();
    if (!name) {
      return res.status(422).json({ message: 'name is required' });
    }

    const type = body.type || 'event';
    if (!PROJECT_TYPES.includes(type)) {
      return res.status(422).json({ message: `type must be one of: ${PROJECT_TYPES.join(', ')}` });
    }

    const clientAccountId = body.clientAccountId || body.clientId;
    if (!clientAccountId) {
      return res.status(422).json({ message: 'clientAccountId is required' });
    }

    const db = req.database;

    const project = await db.clientProject.create({
      id: uuidv4(),
      tenantId,
      clientAccountId,
      businessInfoId: body.businessInfoId || body.siteId || null,
      name,
      type,
      description: body.description || null,
      status: PROJECT_STATUSES.includes(body.status) ? body.status : 'active',
      startDate: body.startDate || null,
      endDate: body.endDate || null,
      location: body.location || null,
      estimatedHours: body.estimatedHours ? parseFloat(body.estimatedHours) : null,
      assignedGuards: Array.isArray(body.assignedGuards) ? body.assignedGuards : [],
      notes: body.notes || null,
    });

    return res.status(201).json(project);
  } catch (err: any) {
    console.error('clientProjectCreate error:', err);
    return res.status(500).json({ message: err.message || 'Error creating project' });
  }
};
