/**
 * SuperAdmin Authentication Middleware - Simplified
 * 
 * Handles authentication and authorization for superadmin endpoints.
 */

import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

// Extend Express Request to include superadmin data
declare global {
  namespace Express {
    interface Request {
      superadmin?: {
        id: string;
        role: string;
        permissions: string[];
      };
    }
  }
}

// Rate limiting store
const rateLimitStore: Map<string, { count: number; resetAt: number }> = new Map();

// Audit log store
const auditLog: Array<{
  timestamp: Date;
  action: string;
  adminId: string;
  ip: string;
  details: string;
}> = [];

export class SuperAdminAuthMiddleware {
  private static readonly API_KEY = process.env.SUPERADMIN_API_KEY || 'default-superadmin-key';
  private static readonly JWT_SECRET = process.env.SUPERADMIN_SECRET || 'superadmin-jwt-secret';
  private static readonly RATE_LIMIT = parseInt(process.env.SUPERADMIN_RATE_LIMIT || '100', 10);
  private static readonly RATE_WINDOW_MS = parseInt(process.env.SUPERADMIN_RATE_WINDOW_MS || '60000', 10);
  private static readonly IP_WHITELIST = (process.env.SUPERADMIN_IP_WHITELIST || '127.0.0.1').split(',').map(ip => ip.trim());

  /**
   * Main authentication middleware
   */
  static authenticate = (req: Request, res: Response, next: NextFunction): void => {
    try {
      const clientIp = req.ip || req.socket.remoteAddress || 'unknown';

      // Rate limiting
      if (!SuperAdminAuthMiddleware.checkRateLimit(clientIp)) {
        res.status(429).json({
          success: false,
          error: 'Rate limit exceeded',
        });
        return;
      }

      // Check API key
      const apiKey = req.headers['x-superadmin-api-key'] as string;
      if (apiKey && apiKey === SuperAdminAuthMiddleware.API_KEY) {
        req.superadmin = {
          id: 'api-key-auth',
          role: 'superadmin',
          permissions: ['*'],
        };
        SuperAdminAuthMiddleware.logAction(req, 'api_key_auth', 'Authenticated via API key');
        next();
        return;
      }

      // Check JWT
      const authHeader = req.headers.authorization;
      if (authHeader && authHeader.startsWith('Bearer ')) {
        const token = authHeader.substring(7);
        try {
          const decoded = jwt.verify(token, SuperAdminAuthMiddleware.JWT_SECRET) as {
            id: string;
            role: string;
            permissions: string[];
          };
          
          if (decoded.role !== 'superadmin') {
            res.status(403).json({
              success: false,
              error: 'Insufficient permissions',
            });
            return;
          }

          req.superadmin = decoded;
          SuperAdminAuthMiddleware.logAction(req, 'jwt_auth', 'Authenticated via JWT');
          next();
          return;
        } catch (jwtError) {
          res.status(401).json({
            success: false,
            error: 'Invalid token',
          });
          return;
        }
      }

      // No valid authentication
      res.status(401).json({
        success: false,
        error: 'Authentication required. Provide X-SuperAdmin-Api-Key header or Bearer token.',
      });
    } catch (error) {
      console.error('SuperAdmin auth error:', error);
      res.status(500).json({
        success: false,
        error: 'Authentication error',
      });
    }
  };

  /**
   * Check rate limit for IP
   */
  private static checkRateLimit(ip: string): boolean {
    const now = Date.now();
    const record = rateLimitStore.get(ip);

    if (!record || now > record.resetAt) {
      rateLimitStore.set(ip, {
        count: 1,
        resetAt: now + SuperAdminAuthMiddleware.RATE_WINDOW_MS,
      });
      return true;
    }

    if (record.count >= SuperAdminAuthMiddleware.RATE_LIMIT) {
      return false;
    }

    record.count++;
    return true;
  }

  /**
   * Log admin action
   */
  private static logAction(req: Request, action: string, details: string): void {
    auditLog.push({
      timestamp: new Date(),
      action,
      adminId: req.superadmin?.id || 'unknown',
      ip: req.ip || 'unknown',
      details,
    });

    // Keep only last 1000 entries
    if (auditLog.length > 1000) {
      auditLog.shift();
    }
  }

  /**
   * Get audit log
   */
  static getAuditLog(limit: number = 100): typeof auditLog {
    return auditLog.slice(-limit);
  }

  /**
   * Generate a superadmin JWT token
   */
  static generateToken(payload: { id: string; role: string; permissions?: string[] }): string {
    return jwt.sign(
      {
        ...payload,
        permissions: payload.permissions || ['*'],
      },
      SuperAdminAuthMiddleware.JWT_SECRET,
      { expiresIn: '24h' }
    );
  }
}

export default SuperAdminAuthMiddleware;
