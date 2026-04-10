/**
 * Health Check Endpoint for CGUARD Backend
 * 
 * Used by:
 * - Load balancers (HAProxy, Nginx, AWS ALB)
 * - Kubernetes liveness/readiness probes
 * - Monitoring systems (Prometheus, Datadog)
 * - PM2 cluster mode coordination
 */

import { Router, Request, Response } from 'express';
import { getConfig } from '../config';

const router = Router();

interface HealthStatus {
  status: 'healthy' | 'degraded' | 'unhealthy';
  timestamp: string;
  uptime: number;
  version: string;
  environment: string;
  checks: {
    database: { status: string; latency?: number; error?: string };
    memory: { status: string; used: number; limit: number; percentage: number };
    tenantMode: string;
  };
}

/**
 * GET /api/health
 * 
 * Returns health status of the application.
 * Status codes:
 * - 200: Healthy
 * - 503: Unhealthy (use for load balancer to remove from rotation)
 */
router.get('/health', async (req: Request, res: Response) => {
  const startTime = Date.now();
  
  const health: HealthStatus = {
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    version: process.env.npm_package_version || '1.0.0',
    environment: process.env.NODE_ENV || 'development',
    checks: {
      database: { status: 'unknown' },
      memory: { status: 'unknown', used: 0, limit: 0, percentage: 0 },
      tenantMode: process.env.TENANT_MODE || 'single',
    },
  };

  // Check database connectivity
  try {
    const database = (req as any).database;
    if (database && database.sequelize) {
      const dbStart = Date.now();
      await database.sequelize.authenticate();
      health.checks.database = {
        status: 'connected',
        latency: Date.now() - dbStart,
      };
    } else {
      health.checks.database = { status: 'not_initialized' };
    }
  } catch (error: any) {
    health.status = 'unhealthy';
    health.checks.database = {
      status: 'disconnected',
      error: error.message || 'Unknown database error',
    };
  }

  // Check memory usage
  const memUsage = process.memoryUsage();
  const memLimit = 1024 * 1024 * 1024; // 1GB limit
  const memPercentage = (memUsage.heapUsed / memLimit) * 100;
  
  health.checks.memory = {
    status: memPercentage > 90 ? 'critical' : memPercentage > 70 ? 'warning' : 'ok',
    used: Math.round(memUsage.heapUsed / 1024 / 1024), // MB
    limit: Math.round(memLimit / 1024 / 1024), // MB
    percentage: Math.round(memPercentage * 100) / 100,
  };

  if (memPercentage > 90) {
    health.status = 'degraded';
  }

  // Return appropriate status code
  const statusCode = health.status === 'unhealthy' ? 503 : 200;
  res.status(statusCode).json(health);
});

/**
 * GET /api/health/ready
 * 
 * Readiness probe - returns 200 only when app is ready to receive traffic.
 * Use for Kubernetes readiness probes or load balancer health checks.
 */
router.get('/health/ready', async (req: Request, res: Response) => {
  try {
    const database = (req as any).database;
    if (database && database.sequelize) {
      await database.sequelize.authenticate();
      res.status(200).json({ ready: true });
    } else {
      res.status(503).json({ ready: false, reason: 'database_not_initialized' });
    }
  } catch (error: any) {
    res.status(503).json({ ready: false, reason: error.message });
  }
});

/**
 * GET /api/health/live
 * 
 * Liveness probe - returns 200 if process is alive.
 * Use for Kubernetes liveness probes.
 */
router.get('/health/live', (req: Request, res: Response) => {
  res.status(200).json({ alive: true, uptime: process.uptime() });
});

export default function (routes: Router) {
  routes.use('/', router);
}
