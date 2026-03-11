import { Request, Response } from 'express';
const TenantUserPostSite = require('../database/models').default().tenant_user_postsite;

// List all assignments
export async function listTenantUserPostSite(req: Request, res: Response) {
  const records = await TenantUserPostSite.findAll();
  res.json(records);
}

// Create assignment
export async function createTenantUserPostSite(req: Request, res: Response) {
  const { tenantUserId, businessInfoId, security_guard_id } = req.body;
  const record = await TenantUserPostSite.create({
    tenantUserId,
    businessInfoId,
    security_guard_id,
  });
  res.status(201).json(record);
}

// Delete assignment
export async function deleteTenantUserPostSite(req: Request, res: Response) {
  const { id } = req.params;
  const deleted = await TenantUserPostSite.destroy({ where: { id } });
  res.json({ deleted });
}
