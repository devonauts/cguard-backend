import { Request, Response, NextFunction } from 'express'
import AuthService from '../services/auth/authService'
import ApiResponseHandler from '../api/apiResponseHandler'
import Error401 from '../errors/Error401'

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
  console.log('🔐 authMiddleware — Authorization header:', auth, 'cookie __session:', cookie)
  if (!bearer && !cookie) return next()
  const idToken = bearer || cookie
  try {
    const currentUser: any = await AuthService.findByToken(idToken, req)
    ;(req as any).currentUser = currentUser
    return next()
  } catch (error) {
    return ApiResponseHandler.error(req, res, new Error401())
  }
}
