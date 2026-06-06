import { v4 as uuidv4 } from 'uuid';
import PermissionChecker from '../../services/user/permissionChecker';
import Permissions from '../../security/permissions';

const PROJECT_TYPES = ['event', 'investigation', 'alarm_response', 'consulting', 'other'];
const PROJECT_STATUSES = ['active', 'completed', 'cancelled', 'on_hold'];

export default async (req, res) => {
  try {
    // C10: this handler previously bypassed the permission check and never
    // verified the clientAccount belonged to the caller's tenant — a tenant
    // isolation gap. Gate it and validate ownership.
    new PermissionChecker(req).validateHas(Permissions.values.clientAccountEdit);

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

    // Tenant isolation: the clientAccount (and site, if given) MUST belong to
    // this tenant — otherwise a user could attach a project to another tenant's
    // client.
    const client = await db.clientAccount.findOne({
      where: { id: clientAccountId, tenantId, deletedAt: null },
      attributes: ['id'],
    });
    if (!client) {
      return res.status(404).json({ message: 'clientAccount not found in this tenant' });
    }
    const businessInfoId = body.businessInfoId || body.siteId || null;
    if (businessInfoId) {
      const site = await db.businessInfo.findOne({
        where: { id: businessInfoId, tenantId, deletedAt: null },
        attributes: ['id'],
      });
      if (!site) {
        return res.status(404).json({ message: 'site (businessInfo) not found in this tenant' });
      }
    }

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
