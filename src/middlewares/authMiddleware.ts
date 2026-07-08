import { Request, Response, NextFunction } from 'express'
import AuthService from '../services/auth/authService'
import jwt from 'jsonwebtoken'
import ApiResponseHandler from '../api/apiResponseHandler'
import Error401 from '../errors/Error401'
import isInfrastructureError from '../errors/isInfrastructureError'
import RoleRepository from '../database/repositories/roleRepository'

const PUBLIC_PREFIXES = [
  '/api/auth/sign-in',
  '/api/auth/sign-up',
  '/api/auth/send-password-reset-email',
  '/api/plan/stripe/webhook',
  // Public tokened video-clip share link (customer-facing, no login).
  '/api/video/clip/shared',
  '/api/docs',
  // Public documentation UI and config
  '/documentation',
  '/documentation-config'
]

export async function authMiddleware(req: Request, res: Response, next: NextFunction) {
  const url = req.originalUrl || req.path || ''
  if (PUBLIC_PREFIXES.some((p) => url.startsWith(p))) return next()
  const auth = req.headers.authorization || ''
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : null
  const cookie = (req as any).cookies?.__session
  // Token diagnostics leak user ids / token fragments into prod logs — gate behind an
  // explicit debug flag (set AUTH_DEBUG=true to re-enable locally).
  if (process.env.AUTH_DEBUG === 'true') {
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
  }
  if (!bearer && !cookie) return next()
  const idToken = bearer || cookie
  try {
    const currentUser: any = await AuthService.findByToken(idToken, req)
    ;(req as any).currentUser = currentUser

    // ── Single-device login enforcement (CLIENT app only) ──────────────────────
    // Only customer tokens carry `clientAccountId`; CRM/worker/guard tokens don't, so
    // this never affects them. A customer token is valid ONLY if its `sid` matches the
    // clientAccount's current activeSessionId. A new sign-in rotates that sid, so the
    // previous device's token is superseded → 401 → it logs out. Tokens issued before
    // this feature (no `sid`) are also superseded, forcing a one-time re-login.
    try {
      const decodedTok: any = jwt.decode(idToken)
      if (decodedTok && decodedTok.clientAccountId) {
        const ca: any = await (req as any).database.clientAccount.findOne({
          where: { id: decodedTok.clientAccountId },
          attributes: ['activeSessionId'],
        })
        const active = ca && ca.activeSessionId
        // Enforce once an active session exists on the account; if the token lacks a sid
        // (legacy) or it doesn't match, supersede it.
        if (active && decodedTok.sid !== active) {
          const lang = (req as any).language || undefined
          return ApiResponseHandler.error(req, res, new Error401(lang, 'auth.sessionSuperseded'))
        }
      }
    } catch (sessErr) {
      // Never let the session check itself break auth — fail open on unexpected errors.
    }

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
                .catch((err: any) => console.warn('RoleRepository priming failed for tenant', tid, (err && (err as any).message) ? (err as any).message : err));
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
      console.debug('🔐 authMiddleware — AuthService.findByToken failed:', error && (error as any).message ? (error as any).message : error);
    } catch (e) {
      // ignore
    }

    // A DB / infrastructure failure while validating the token is NOT an auth
    // failure. Returning 401 here logs the user out on a transient blip (e.g. the
    // DB connection pool being exhausted → "Too many connections"), which is
    // exactly what caused users to keep getting kicked out mid-session. Return a
    // retryable 503 instead so the client backs off and the SESSION IS PRESERVED.
    if (isInfrastructureError(error)) {
      try {
        console.warn('🔐 authMiddleware — infrastructure error during token validation → 503 (session preserved):', error && (error as any).message ? (error as any).message : error);
      } catch (e) { /* ignore */ }
      return res.status(503).json({
        message: 'Service temporarily unavailable, please retry.',
        code: 503,
        retryable: true,
      })
    }

    // If the token expired, return a specific message code so the UI can prompt re-login
    const errMsg = error && (error as any).message ? (error as any).message : '';
    if (errMsg && errMsg.toLowerCase().includes('jwt expired')) {
      const lang = (req as any).language || undefined;
      return ApiResponseHandler.error(req, res, new Error401(lang, 'auth.tokenExpired'))
    }

    return ApiResponseHandler.error(req, res, new Error401())
  }
}
