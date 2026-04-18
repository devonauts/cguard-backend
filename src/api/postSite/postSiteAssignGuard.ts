/** @openapi { "summary": "Assign a guard to a post site (creates a shift or pivot entry)", "requestBody": { "content": { "application/json": { "schema": { "type": "object", "properties": { "tenantUserId": { "type": "string" }, "tenant_user_id": { "type": "string" }, "securityGuardId": { "type": "string" }, "security_guard_id": { "type": "string" }, "stationId": { "type": "string" }, "station_id": { "type": "string" }, "siteTours": { "type": "array", "items": { "type": "object" } }, "assignSiteTours": { "type": "array", "items": { "type": "object" } }, "tasks": { "type": "array", "items": { "type": "object" } }, "assignTasks": { "type": "array", "items": { "type": "object" } }, "postOrders": { "type": "array", "items": { "type": "object" } }, "assignPostOrders": { "type": "array", "items": { "type": "object" } }, "checklists": { "type": "array", "items": { "type": "object" } }, "assignChecklists": { "type": "array", "items": { "type": "object" } }, "skillSet": { "type": "array", "items": { "type": "string" } }, "skill_set": { "type": "array", "items": { "type": "string" } }, "department": { "type": "string" }, "clientAccountId": { "type": "string" }, "client_account_id": { "type": "string" } }, "required": [] } } } }, "responses": { "200": { "description": "Shift created / assignment succeeded" }, "400": { "description": "Bad Request" } } } */

import PermissionChecker from '../../services/user/permissionChecker';
import Permissions from '../../security/permissions';
import ApiResponseHandler from '../apiResponseHandler';
import TenantUserRepository from '../../database/repositories/tenantUserRepository';
import ShiftService from '../../services/shiftService';
import { randomUUID } from 'crypto';

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
            console.log('[DEBUG] assign-guard - No securityGuard found for securityGuardId:', incoming.securityGuardId);
          }
        }
      }
      
      // If no securityGuardId in request but we have tenantUserId, try to resolve from tenantUser.userId
      if (!resolvedSecurityGuardId && tenantUserId) {
        console.log('[DEBUG] assign-guard - Attempting to resolve securityGuard from tenantUserId:', tenantUserId);
        const tenantUser = await req.database.tenantUser.findOne({ 
          where: { id: tenantUserId },
          include: [{ model: req.database.user, as: 'user' }]
        });
        
        if (tenantUser && tenantUser.user && tenantUser.user.id) {
          const userId = tenantUser.user.id;
          console.log('[DEBUG] assign-guard - TenantUser userId:', userId);
          
          const sgByUserId = await req.database.securityGuard.findOne({ 
            where: { guardId: userId, tenantId } 
          });
          
          if (sgByUserId && sgByUserId.id) {
            resolvedSecurityGuardId = sgByUserId.id;
            console.log('[DEBUG] assign-guard - Resolved securityGuard from tenantUser.userId:', resolvedSecurityGuardId);
          } else {
            console.log('[DEBUG] assign-guard - No securityGuard found for tenantUser.userId:', userId);
          }
        }
      }
    } catch (err) {
      const errorMsg = (err as any)?.message || String(err);
      console.warn('postSiteAssignGuard: failed to resolve securityGuard record', errorMsg);
    }
    
    console.log('[DEBUG] assign-guard - Final resolvedSecurityGuardId:', resolvedSecurityGuardId);
    // Detect DB schema: whether tenant_user_post_sites has station_id column
    let hasStationColumn = false;
    try {
      const desc = await req.database.sequelize.getQueryInterface().describeTable('tenant_user_post_sites');
      hasStationColumn = !!desc && Object.prototype.hasOwnProperty.call(desc, 'station_id');
    } catch (e) {
      // ignore — we'll assume column missing
      hasStationColumn = false;
    }

    // Create a Shift record instead of writing directly to tenant_user_post_sites pivot.
    try {
      // Load tenantUser to obtain the underlying user id for the guard (if available)
      let tenantUserRecord: any = null;
      try {
        tenantUserRecord = await req.database.tenantUser.findOne({ where: { id: tenantUserId }, include: [{ model: req.database.user, as: 'user' }] });
      } catch (e) {
        tenantUserRecord = null;
      }

      const shiftPayload: any = {
        postSite: postSiteId,
        tenantUserId,
        station: incoming.stationId || incoming.station_id || null,
        siteTours: incoming.siteTours ?? incoming.assignSiteTours,
        tasks: incoming.tasks ?? incoming.assignTasks,
        postOrders: incoming.postOrders ?? incoming.assignPostOrders,
        checklists: incoming.checklists ?? incoming.assignChecklists,
        skillSet: incoming.skillSet ?? incoming.skill_set,
        department: incoming.department ?? incoming.department,
      };

      if (tenantUserRecord && (tenantUserRecord as any).user && (tenantUserRecord as any).user.id) {
        shiftPayload.guard = (tenantUserRecord as any).user.id;
      }

      console.log('[DEBUG] Creating Shift with payload:', JSON.stringify(shiftPayload, null, 2));

      const shiftService = new ShiftService({ currentTenant: req.currentTenant, language: req.language, database: req.database, currentUser: req.currentUser });
      await shiftService.create(shiftPayload);

      console.log('[DEBUG] Shift created successfully for tenantUserId:', tenantUserId);
    } catch (err) {
      console.error('[ERROR] Failed to create shift for assignment:', (err as any)?.message || String(err));
      // As a fallback for older deployments, attempt to write the pivot row if possible.
      try {
        const row: any = {
          id: randomUUID(),
          tenantUserId,
          businessInfoId: postSiteId,
          security_guard_id: resolvedSecurityGuardId || null,
          site_tours: normalizeJsonField(incoming.siteTours ?? incoming.assignSiteTours),
          tasks: normalizeJsonField(incoming.tasks ?? incoming.assignTasks),
          post_orders: normalizeJsonField(incoming.postOrders ?? incoming.assignPostOrders),
          checklists: normalizeJsonField(incoming.checklists ?? incoming.assignChecklists),
          skill_set: normalizeJsonField(incoming.skillSet ?? incoming.skill_set),
          department: normalizeJsonField(incoming.department ?? incoming.department),
          createdAt: now,
          updatedAt: now,
        };

        if (hasStationColumn) {
          row.station_id = incoming.stationId || incoming.station_id || null;
        }

        console.log('[DEBUG] Fallback: attempting to insert tenant_user_post_sites with data:', JSON.stringify(row, null, 2));
        await req.database.sequelize.getQueryInterface().bulkInsert('tenant_user_post_sites', [row]);
        console.log('[DEBUG] Fallback insert successful');
      } catch (innerErr) {
        console.error('[ERROR] Fallback insert failed:', (innerErr as any)?.message || String(innerErr));
      }
    }

    // If frontend provided a clientAccountId, also ensure tenant_user_client_accounts pivot exists
    try {
      const clientAccountId = incoming.clientAccountId || incoming.client_account_id || null;
      if (clientAccountId) {
        const clientRow = {
          id: randomUUID(),
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
