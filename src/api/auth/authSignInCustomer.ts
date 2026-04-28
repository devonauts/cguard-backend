/** @openapi { "summary": "Sign in (customer app)", "requestBody": { "content": { "application/json": { "schema": { "type": "object", "properties": { "email": { "type": "string" }, "password": { "type": "string" }, "invitationToken": { "type": "string" }, "tenantId": { "type": "string" } }, "required": ["email","password"] } } } }, "responses": { "200": { "description": "Auth payload (customer trimmed tenant)" }, "401": { "description": "Invalid credentials" } } } */

import ApiResponseHandler from '../apiResponseHandler'
import AuthService from '../../services/auth/authService'
import Error400 from '../../errors/Error400'
import BannerSuperiorAppService from '../../services/bannerSuperiorAppService'
import CertificationService from '../../services/certificationService'
import ServiceService from '../../services/serviceService'
import Roles from '../../security/roles'
import SequelizeRepository from '../../database/repositories/sequelizeRepository'

export default async (req: any, res: any) => {
  try {
    // Reuse signin logic to authenticate and obtain token + user
    const payload: any = await AuthService.signin(
      req.body.email,
      req.body.password,
      req.body.invitationToken,
      req.body.tenantId,
      req,
    )

    // payload: { token, user }
    // Ensure DB reference for additional checks
    const db = (req && (req as any).database) ? (req as any).database : (req && req.app && req.app.locals && (req.app.locals as any).database) ? (req.app.locals as any).database : undefined;

    if (payload && payload.user && payload.user.tenant) {
      const tenantEntry: any = payload.user.tenant;
      const tenantId = tenantEntry.tenantId || (tenantEntry.tenant && tenantEntry.tenant.id) || null;

      // Build a trimmed tenant object (always an object to simplify assignment)
      const tenantData: any = tenantEntry.tenant || {};
      // Ensure sensitive/unused tenant fields are removed from the customer payload
      try {
        delete tenantData.url;
        delete tenantData.plan;
        delete tenantData.logoId;
      } catch (e) {
        // ignore
      }
      const trimmed: any = {
        id: tenantData.id || null,
        name: tenantData.name || null,
      };

      // Validate that the tenant entry includes the `customer` role
      const roles = Array.isArray(tenantEntry.roles) ? tenantEntry.roles : [];
      if (!roles.includes(Roles.values.customer)) {
        throw new Error400(req.language, 'auth.roleNotCustomer');
      }

      // If role includes `customer`, fetch compact asset ids
      if (tenantId && roles.includes(Roles.values.customer)) {
        // Attach currentTenant to req so services operate in tenant scope
        req.currentTenant = { id: tenantId };

        try {
          const banners = await new BannerSuperiorAppService(req).findAndCountAll({ filter: {}, limit: 0 });
          const certs = await new CertificationService(req).findAndCountAll({ filter: {}, limit: 0 });
          const services = await new ServiceService(req).findAndCountAll({ filter: {}, limit: 0 });
          trimmed.bannerIds = Array.isArray(banners.rows) ? banners.rows.map((r: any) => r.id) : [];
          trimmed.certificationIds = Array.isArray(certs.rows) ? certs.rows.map((r: any) => r.id) : [];
          trimmed.serviceIds = Array.isArray(services.rows) ? services.rows.map((r: any) => r.id) : [];
        } catch (err) {
          console.warn('authSignInCustomer: could not load tenant assets', (err && (err as any).message) ? (err as any).message : err);
          trimmed.bannerIds = trimmed.bannerIds || [];
          trimmed.certificationIds = trimmed.certificationIds || [];
          trimmed.serviceIds = trimmed.serviceIds || [];
        }
      }

      // Replace tenant payload with trimmed version (preserve roles/permissions/status)
      payload.user.tenant = {
        tenantId: tenantEntry.tenantId,
        tenant: trimmed,
        roles: tenantEntry.roles || [],
        permissions: tenantEntry.permissions || [],
        assignedClients: tenantEntry.assignedClients || [],
        assignedPostSites: tenantEntry.assignedPostSites || [],
        status: tenantEntry.status || null,
      };

      // clientAccount lookup moved below so it's executed even if tenant is null
    }
    // If tenant payload is null, ensure the user has at least one tenant entry with `customer` role
    if (payload && payload.user && !payload.user.tenant) {
      try {
        if (db) {
          const tenantUsers = await db.tenantUser.findAll({ where: { userId: payload.user.id }, attributes: ['roles', 'tenantId'] });
          let hasCustomer = false;
          if (Array.isArray(tenantUsers) && tenantUsers.length) {
            for (const tu of tenantUsers) {
              try {
                let roles: any = tu.roles;
                if (typeof roles === 'string') {
                  try { roles = JSON.parse(roles); } catch (e) { roles = [roles]; }
                }
                if (Array.isArray(roles) && roles.includes(Roles.values.customer)) {
                  hasCustomer = true;
                  break;
                }
              } catch (e) {
                // ignore parsing errors
              }
            }
          }
          if (!hasCustomer) {
            throw new Error400(req.language, 'auth.roleNotCustomer');
          }
        }
      } catch (e) {
        // If DB check fails, surface the original DB error or roleNotCustomer
        if (e instanceof Error400) throw e;
        console.warn('authSignInCustomer: tenantUser lookup failed', e && (e as any).message ? (e as any).message : e);
      }
    }
    // Attach clientAccount id if this user is linked to a clientAccount (always attempt)
    try {
      if (payload && payload.user && payload.user.id) {
        // Determine tenant context candidate from payload or request
        const tenantIdCandidate = (payload.user.tenant && (payload.user.tenant.tenantId || (payload.user.tenant.tenant && payload.user.tenant.tenant.id))) || req.body?.tenantId || (req.currentTenant && req.currentTenant.id) || null;

        // Do not overwrite existing currentTenant if present; only set when we have a candidate and no currentTenant
        if (tenantIdCandidate && !(req && (req as any).currentTenant)) {
          req.currentTenant = { id: tenantIdCandidate };
        }

        const db = (req && (req as any).database) ? (req as any).database : (req && req.app && req.app.locals && (req.app.locals as any).database) ? (req.app.locals as any).database : undefined;
        console.warn('authSignInCustomer: diagnostic', {
          userId: payload.user.id,
          tenantIdCandidate: tenantIdCandidate,
          dbPresent: !!db,
        });
        if (db) {
          // First try direct userId on clientAccount
          try {
            const where: any = { userId: payload.user.id };
            if (tenantIdCandidate) where.tenantId = tenantIdCandidate;
            const clientRec = await db.clientAccount.findOne({ where });
            console.warn('authSignInCustomer: clientAccount lookup result', { where, found: !!clientRec, clientId: clientRec ? clientRec.id : null });
            if (clientRec) {
              payload.user.clientAccountId = clientRec.id;
            } else {
              // Fallback 1: check tenantUser pivot assignedClients
              let foundViaFallback = false;
              try {
                const tenantUserWhere: any = { userId: payload.user.id };
                if (tenantIdCandidate) tenantUserWhere.tenantId = tenantIdCandidate;
                const tenantUser = await db.tenantUser.findOne({ where: tenantUserWhere, include: [{ model: db.clientAccount, as: 'assignedClients', attributes: ['id'] }] });
                const assigned = tenantUser && tenantUser.assignedClients ? tenantUser.assignedClients.map((c: any) => c.id) : [];
                console.warn('authSignInCustomer: tenantUser fallback', { where: tenantUserWhere, found: !!tenantUser, assignedClients: assigned });
                if (tenantUser && tenantUser.assignedClients && tenantUser.assignedClients.length) {
                  payload.user.clientAccountId = tenantUser.assignedClients[0].id;
                  foundViaFallback = true;
                }
              } catch (e) {
                console.warn('authSignInCustomer: tenantUser fallback error', e && (e as any).message ? (e as any).message : e);
              }
              // Fallback 2: match by email — handles clientAccount where userId was never set
              if (!foundViaFallback && payload.user.email) {
                try {
                  const emailWhere: any = { email: payload.user.email };
                  if (tenantIdCandidate) emailWhere.tenantId = tenantIdCandidate;
                  const emailRec = await db.clientAccount.findOne({ where: emailWhere });
                  if (emailRec) {
                    console.warn('authSignInCustomer: email fallback found clientAccount', { id: emailRec.id });
                    payload.user.clientAccountId = emailRec.id;
                    // Heal the data: set userId so future lookups skip this fallback
                    try {
                      await emailRec.update({ userId: payload.user.id });
                    } catch (healErr) {
                      console.warn('authSignInCustomer: could not heal clientAccount.userId', healErr && (healErr as any).message ? (healErr as any).message : healErr);
                    }
                  }
                } catch (e) {
                  console.warn('authSignInCustomer: email fallback error', e && (e as any).message ? (e as any).message : e);
                }
              }
            }
          } catch (e) {
            console.warn('authSignInCustomer: clientAccount lookup error', e && (e as any).message ? (e as any).message : e);
          }
        }
      }
    } catch (err) {
      console.warn('authSignInCustomer: could not lookup clientAccount', (err && (err as any).message) ? (err as any).message : err);
    }

    return ApiResponseHandler.success(req, res, payload)
  } catch (error) {
    return ApiResponseHandler.error(req, res, error)
  }
}
