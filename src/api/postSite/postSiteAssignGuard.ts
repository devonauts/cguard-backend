import PermissionChecker from '../../services/user/permissionChecker';
import Permissions from '../../security/permissions';
import ApiResponseHandler from '../apiResponseHandler';
import TenantUserRepository from '../../database/repositories/tenantUserRepository';

export default async (req, res) => {
  try {
    console.log('[DEBUG] assign-guard - Request body:', JSON.stringify(req.body, null, 2));
    
    new PermissionChecker(req).validateHas(Permissions.values.userEdit);

    const tenantId = req.params.tenantId;
    const postSiteId = req.params.id;
    const incoming = req.body.data || req.body || {};

    console.log('[DEBUG] assign-guard - tenantId:', tenantId);
    console.log('[DEBUG] assign-guard - postSiteId:', postSiteId);
    console.log('[DEBUG] assign-guard - incoming:', incoming);

    // Resolve tenantUser: prefer explicit tenantUserId, else try to find by user id
    let tenantUserId = incoming.tenantUserId || incoming.tenant_user_id || null;
    if (!tenantUserId && incoming.securityGuardId) {
      const tenantUser = await TenantUserRepository.findByTenantAndUser(tenantId, incoming.securityGuardId, req);
      if (tenantUser && tenantUser.id) tenantUserId = tenantUser.id;
    }

    console.log('[DEBUG] assign-guard - Resolved tenantUserId:', tenantUserId);

    if (!tenantUserId) {
      throw new Error('tenantUserId or securityGuardId required');
    }

    const now = new Date();

    // Normalize fields that are stored as JSON in the DB. Accepts arrays, objects,
    // JSON strings, or single scalar values. Returns `null` when empty.
    function normalizeJsonField(value) {
      if (value === undefined || value === null) return null;
      if (typeof value === 'string') {
        const trimmed = value.trim();
        if (!trimmed) return null;
        // If it looks like JSON, try to parse and return normalized JSON
        if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
          try {
            const parsed = JSON.parse(trimmed);
            return JSON.stringify(parsed);
          } catch (e) {
            // Not valid JSON text; fallthrough to treat as scalar
          }
        }
        // Treat scalar string as a scalar JSON value (not an array)
        return JSON.stringify(trimmed);
      }
      if (Array.isArray(value) || typeof value === 'object') {
        try {
          return JSON.stringify(value);
        } catch (e) {
          return null;
        }
      }
      // For numbers/booleans etc., return scalar JSON
      return JSON.stringify(value);
    }


    // Resolve security_guard_id: the frontend may send either a securityGuard record id
    // (the PK from `securityguards`), or a user id (guard/user id). We must store the
    // securityGuard record id in the `security_guard_id` FK column to satisfy the FK.
    let resolvedSecurityGuardId = null;
    try {
      if (incoming.securityGuardId) {
        console.log('[DEBUG] assign-guard - Looking for securityGuard with id:', incoming.securityGuardId);
        // Try interpreting incoming value as a securityGuard.id first
        const byId = await req.database.securityGuard.findOne({ where: { id: incoming.securityGuardId, tenantId } });
        if (byId && byId.id) {
          resolvedSecurityGuardId = byId.id;
          console.log('[DEBUG] assign-guard - Found by ID:', resolvedSecurityGuardId);
        } else {
          // Otherwise try to find a securityGuard row that references the user id (guardId)
          const byGuard = await req.database.securityGuard.findOne({ where: { guardId: incoming.securityGuardId, tenantId } });
          if (byGuard && byGuard.id) {
            resolvedSecurityGuardId = byGuard.id;
            console.log('[DEBUG] assign-guard - Found by guardId:', resolvedSecurityGuardId);
          } else {
            console.log('[DEBUG] assign-guard - No securityGuard found');
          }
        }
      }
    } catch (err) {
      const errorMsg = (err as any)?.message || String(err);
      console.warn('postSiteAssignGuard: failed to resolve securityGuard record for incoming.securityGuardId', incoming.securityGuardId, errorMsg);
    }
    
    console.log('[DEBUG] assign-guard - Final resolvedSecurityGuardId:', resolvedSecurityGuardId);

    const row = {
      id: require('crypto').randomBytes(16).toString('hex'),
      tenantUserId,
      businessInfoId: postSiteId,
      // Use resolvedSecurityGuardId (securityGuard record id) to satisfy FK constraint.
      security_guard_id: resolvedSecurityGuardId || null,
      site_tours: normalizeJsonField(incoming.siteTours ?? incoming.assignSiteTours),
      tasks: normalizeJsonField(incoming.tasks ?? incoming.assignTasks),
      post_orders: normalizeJsonField(incoming.postOrders ?? incoming.assignPostOrders),
      checklists: normalizeJsonField(incoming.checklists ?? incoming.assignChecklists),
      // Persist skill set and department (support camelCase or snake_case from frontend)
      // Ensure values are valid JSON text for JSON columns.
      skill_set: normalizeJsonField(incoming.skillSet ?? incoming.skill_set),
      department: normalizeJsonField(incoming.department ?? incoming.department),
      createdAt: now,
      updatedAt: now,
    };

    try {
      console.log('[DEBUG] Attempting to insert tenant_user_post_sites with data:', JSON.stringify(row, null, 2));
      await req.database.sequelize.getQueryInterface().bulkInsert('tenant_user_post_sites', [row]);
      console.log('[DEBUG] Insert successful');
    } catch (err) {
      console.error('[ERROR] Failed to insert tenant_user_post_sites row:', err);
      console.error('[ERROR] Row data was:', JSON.stringify(row, null, 2));
      console.error('[ERROR] Full error details:', {
        message: (err as any)?.message,
        code: (err as any)?.code,
        sql: (err as any)?.sql,
        parent: (err as any)?.parent,
      });
      throw err;
    }

    // If frontend provided a clientAccountId, also ensure tenant_user_client_accounts pivot exists
    try {
      const clientAccountId = incoming.clientAccountId || incoming.client_account_id || null;
      if (clientAccountId) {
        const clientRow = {
          id: require('crypto').randomBytes(16).toString('hex'),
          tenantUserId,
          clientAccountId,
          // include security_guard_id when available to tie pivot to the securityGuard record
          security_guard_id: resolvedSecurityGuardId || null,
          createdAt: now,
          updatedAt: now,
        };
        try {
          await req.database.sequelize.getQueryInterface().bulkInsert('tenant_user_client_accounts', [clientRow]);
        } catch (innerErr) {
          // ignore duplicate/index errors or other insert errors
          console.debug('postSiteAssignGuard: tenant_user_client_accounts insert skipped or failed', (innerErr as any)?.message || String(innerErr));
        }
      }
    } catch (err) {
      console.warn('postSiteAssignGuard: error while attempting to create tenant_user_client_accounts pivot', (err as any)?.message || String(err));
    }

    await ApiResponseHandler.success(req, res, true);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
