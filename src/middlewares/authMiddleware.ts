import { Request, Response, NextFunction } from 'express'
import AuthService from '../services/auth/authService'
import jwt from 'jsonwebtoken'
import ApiResponseHandler from '../api/apiResponseHandler'
import Error401 from '../errors/Error401'
import RoleRepository from '../database/repositories/roleRepository'

const PUBLIC_PREFIXES = [
  '/api/auth/sign-in',
  '/api/auth/sign-up',
  '/api/auth/send-password-reset-email',
  '/api/plan/stripe/webhook',
  '/api/docs'
]

export async function authMiddleware(req: Request, res: Response, next: NextFunction) {
  const url = req.originalUrl || req.path || ''
  if (PUBLIC_PREFIXES.some((p) => url.startsWith(p))) return next()
  const auth = req.headers.authorization || ''
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : null
  const cookie = (req as any).cookies?.__session
  // Avoid logging full token. Decode payload (without verifying) to help debugging.
  try {
    const tokenToInspect = bearer || cookie;
    if (tokenToInspect) {
      const decoded = jwt.decode(tokenToInspect) as any;
      const short = tokenToInspect && tokenToInspect.length > 8 ? `${tokenToInspect.slice(0,6)}...${tokenToInspect.slice(-6)}` : tokenToInspect;
      console.log('🔐 authMiddleware — Authorization token:', short, 'decoded:', decoded ? { id: decoded.id, iat: decoded.iat, exp: decoded.exp } : null, 'cookie __session present:', !!cookie);
    } else {
      console.log('🔐 authMiddleware — No bearer token, cookie __session:', !!cookie);
    }
  } catch (e) {
    console.log('🔐 authMiddleware — token decode failed', e);
  }
  if (!bearer && !cookie) return next()
  const idToken = bearer || cookie
  try {
    const currentUser: any = await AuthService.findByToken(idToken, req)
    ;(req as any).currentUser = currentUser

    // Normalize tenantUser entries to plain objects when Sequelize instances are present
    try {
      const cu: any = (req as any).currentUser;
      if (cu && Array.isArray(cu.tenants)) {
        cu.tenants = cu.tenants.map((t) => {
          try {
            if (t && typeof t.get === 'function') {
              return t.get({ plain: true });
            }
          } catch (e) {
            // ignore and return original
          }
          // If assigned relations are still Sequelize instances inside a plain object,
          // normalize them to plain values as well.
          try {
            if (t && t.assignedClients && Array.isArray(t.assignedClients)) {
              t.assignedClients = t.assignedClients.map((c) => (c && typeof c.get === 'function') ? c.get({ plain: true }) : c);
            }
            if (t && t.assignedPostSites && Array.isArray(t.assignedPostSites)) {
              t.assignedPostSites = t.assignedPostSites.map((p) => (p && typeof p.get === 'function') ? p.get({ plain: true }) : p);
            }
          } catch (err) {
            // ignore
          }

          return t;
        });
      }
    } catch (e) {
      // non-critical
    }

    // Prime role permissions cache synchronously for the current user's tenants
    try {
      const cu: any = (req as any).currentUser;
      if (cu && Array.isArray(cu.tenants) && (req as any).database) {
        for (const t of cu.tenants) {
          try {
            const tid = t.tenantId || (t.tenant && t.tenant.id);
            if (tid) {
              // await to ensure the cache is populated before downstream permission checks
              // do not block if the DB call fails
              // eslint-disable-next-line no-await-in-loop
              await RoleRepository.getPermissionsMapForTenant(tid, { database: (req as any).database })
                .catch((err) => console.warn('RoleRepository priming failed for tenant', tid, err && err.message ? err.message : err));
            }
          } catch (e) {
            // ignore per-tenant errors
          }
        }
      }
    } catch (e) {
      // non-fatal
    }
    return next()
  } catch (error) {
    // Log verification failure to help debugging (without leaking token)
    try {
      console.warn('🔐 authMiddleware — AuthService.findByToken failed:', error && (error as any).message ? (error as any).message : error);
    } catch (e) {
      // ignore
    }
    return ApiResponseHandler.error(req, res, new Error401())
  }
}
