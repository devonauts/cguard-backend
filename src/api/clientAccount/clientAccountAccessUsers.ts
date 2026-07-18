import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import assertClientAccess from '../../services/user/assertClientAccess';

/**
 * Real app-access users for a client: the titular (clientAccount.userId) plus any
 * additional people linked through the tenant_user_client_accounts pivot. Backs
 * the "Accesos" tab so it stops fabricating rows.
 */
export const list = async (req, res) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.clientAccountRead);
    await assertClientAccess(req, req.params.id);
    const db = req.database;
    const tenantId = req.currentTenant && req.currentTenant.id;
    const clientAccountId = req.params.id;

    const client: any = await db.clientAccount.findByPk(clientAccountId, { attributes: ['id', 'userId', 'name', 'email'] });
    const out: any[] = [];

    // Titular (the client's own linked user).
    if (client?.userId) {
      const u: any = await db.user.findByPk(client.userId, { attributes: ['id', 'fullName', 'firstName', 'lastName', 'email'] }).catch(() => null);
      out.push({
        id: 'titular', pivotId: null, userId: client.userId, isTitular: true,
        name: (u && (u.fullName || [u.firstName, u.lastName].filter(Boolean).join(' '))) || client.name || 'Titular',
        email: (u && u.email) || client.email || null, role: 'Titular',
      });
    }

    // Additional access (pivot → tenantUser → user).
    try {
      const pivots = await db.tenant_user_client_accounts.findAll({ where: { tenantId, clientAccountId }, attributes: ['id', 'tenantUserId'] });
      const tuIds = pivots.map((p: any) => String(p.tenantUserId)).filter(Boolean);
      const tus = tuIds.length ? await db.tenantUser.findAll({ where: { id: tuIds, tenantId }, include: [{ model: db.user, attributes: ['id', 'fullName', 'firstName', 'lastName', 'email'], required: false }] }) : [];
      const tuById = new Map<string, any>(tus.map((t: any) => [String(t.id), t]));
      for (const p of pivots) {
        const tu = tuById.get(String(p.tenantUserId));
        const u = tu?.user;
        const roles = Array.isArray(tu?.roles) ? tu.roles : (typeof tu?.roles === 'string' ? String(tu.roles).split(',').filter(Boolean) : []);
        if (client?.userId && u && String(u.id) === String(client.userId)) continue; // don't duplicate titular
        out.push({
          id: String(p.id), pivotId: String(p.id), userId: u ? String(u.id) : null, isTitular: false,
          name: (u && (u.fullName || [u.firstName, u.lastName].filter(Boolean).join(' '))) || (u && u.email) || 'Usuario',
          email: u?.email || null,
          role: roles.includes('customer') ? 'Acceso a la app' : (roles[0] || 'Acceso'),
          status: tu?.status || 'active',
        });
      }
    } catch { /* pivot optional */ }

    return ApiResponseHandler.success(req, res, { users: out });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};

/** Revoke an additional-access link (pivot row). */
export const revoke = async (req, res) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.clientAccountEdit);
    await assertClientAccess(req, req.params.id);
    const db = req.database;
    const tenantId = req.currentTenant && req.currentTenant.id;
    const row: any = await db.tenant_user_client_accounts.findByPk(req.params.pivotId);
    if (!row || row.tenantId !== tenantId || String(row.clientAccountId) !== String(req.params.id)) return ApiResponseHandler.error(req, res, { code: 404 });
    await row.destroy();
    return ApiResponseHandler.success(req, res, { id: req.params.pivotId, revoked: true });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
