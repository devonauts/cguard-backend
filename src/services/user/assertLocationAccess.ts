import Roles from '../../security/roles';
import Error403 from '../../errors/Error403';

/**
 * Resolve the set of postSiteIds a CUSTOMER caller is allowed to see (their own
 * clientAccounts' post sites, primary + multi-access pivot). Returns null for
 * staff/admin (unrestricted). Fails closed if there is no tenant context.
 */
async function customerAllowedPostSiteIds(req: any): Promise<Set<string> | null> {
  const currentUser = req.currentUser;
  const currentTenant = req.currentTenant;
  if (!currentUser || !currentTenant) throw new Error403(req.language);

  const tenantForUser = (currentUser.tenants || [])
    .filter((t: any) => t && t.status === 'active')
    .find((t: any) => t.tenant && t.tenant.id === currentTenant.id);
  if (!tenantForUser) throw new Error403(req.language);

  const roles = tenantForUser.roles || [];
  const isCustomer = Array.isArray(roles)
    ? roles.includes(Roles.values.customer)
    : String(roles) === Roles.values.customer;
  if (!isCustomer) return null; // staff/admin → unrestricted here

  const clientAccountIds: string[] = [];
  const own = await req.database.clientAccount.findAll({
    where: { userId: currentUser.id, tenantId: currentTenant.id },
    attributes: ['id'],
  });
  for (const c of own || []) clientAccountIds.push(c.id);
  try {
    const [granted] = await req.database.sequelize.query(
      `SELECT DISTINCT tuc.clientAccountId cid
         FROM tenant_user_client_accounts tuc
         JOIN tenantUsers tu ON tu.id = tuc.tenantUserId
        WHERE tu.userId = :uid AND (tu.tenantId = :tid OR tuc.tenantId = :tid)
          AND tuc.deletedAt IS NULL`,
      { replacements: { uid: currentUser.id, tid: currentTenant.id } },
    );
    for (const g of granted || []) if (g.cid) clientAccountIds.push(g.cid);
  } catch (e) {
    // pivot missing → primary only
  }

  if (!clientAccountIds.length) return new Set();
  const posts = await req.database.businessInfo.findAll({
    where: { tenantId: currentTenant.id, clientAccountId: clientAccountIds },
    attributes: ['id'],
  });
  return new Set((posts || []).map((p: any) => String(p.id)));
}

/**
 * Assert a customer caller may access AT LEAST ONE of the given location ids
 * (each may be a postSiteId OR a stationId whose postSite they own). Staff/admin
 * pass through. Throws Error403 otherwise. Closes the assigned-guards PII leak
 * where a customer could enumerate any post-site/station UUID in the tenant.
 */
export async function assertLocationAccess(req: any, ...candidateIds: Array<string | undefined>): Promise<void> {
  const allowed = await customerAllowedPostSiteIds(req);
  if (allowed === null) return; // staff/admin

  const ids = candidateIds.filter(Boolean) as string[];
  for (const id of ids) {
    if (allowed.has(String(id))) return; // direct post-site match
  }
  // Else any candidate that is a station in an allowed post site.
  for (const id of ids) {
    const st = await req.database.station.findOne({
      where: { id, tenantId: req.currentTenant.id },
      attributes: ['postSiteId'],
    });
    if (st && st.postSiteId && allowed.has(String(st.postSiteId))) return;
  }
  throw new Error403(req.language);
}
