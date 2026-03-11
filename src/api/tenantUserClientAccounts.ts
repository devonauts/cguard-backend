import { Request, Response } from 'express';
const TenantUserClientAccounts = require('../database/models').default().tenant_user_client_accounts;

// List all assignments
export async function listTenantUserClientAccounts(req: Request, res: Response) {
  const records = await TenantUserClientAccounts.findAll();
  res.json(records);
}

// Create assignment
export async function createTenantUserClientAccount(req: Request, res: Response) {
  const { tenantUserId, clientAccountId, security_guard_id } = req.body;
  const record = await TenantUserClientAccounts.create({
    tenantUserId,
    clientAccountId,
    security_guard_id,
  });
  res.status(201).json(record);
}

// Delete assignment
export async function deleteTenantUserClientAccount(req: Request, res: Response) {
  const { id } = req.params;
  const deleted = await TenantUserClientAccounts.destroy({ where: { id } });
  res.json({ deleted });
}
