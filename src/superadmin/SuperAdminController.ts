/**
 * SuperAdmin Controller - Simplified for compatibility
 * 
 * Enterprise admin API endpoints for SaaS platform management.
 */

import { Router, Request, Response, NextFunction } from 'express';
import { ApiMetricsService } from './services/ApiMetricsService';
import { QueryAnalyzerService } from './services/QueryAnalyzerService';
import { OrphanDetectorService } from './services/OrphanDetectorService';
import { ErrorTrackingService } from './services/ErrorTrackingService';
import { TenantManagementService } from './services/TenantManagementService';
import { SystemHealthService } from './services/SystemHealthService';
import { SuperAdminAuthMiddleware } from './middleware/SuperAdminAuthMiddleware';

const router = Router();

// Apply superadmin authentication to all routes
router.use(SuperAdminAuthMiddleware.authenticate);

/**
 * Helper to wrap async handlers
 */
const asyncHandler = (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>) => 
  (req: Request, res: Response, next: NextFunction) => 
    Promise.resolve(fn(req, res, next)).catch(next);

// ============================================================================
// DASHBOARD
// ============================================================================

router.get('/dashboard', asyncHandler(async (_req: Request, res: Response) => {
  const apiMetrics = ApiMetricsService.getInstance().getSummary(60);
  const tenantStats = await TenantManagementService.getInstance().getGlobalStats();
  const systemHealth = await SystemHealthService.getInstance().getQuickHealth();
  const errorStats = ErrorTrackingService.getInstance().getStats(60);

  res.json({
    success: true,
    data: {
      overview: {
        totalTenants: tenantStats.totalTenants,
        activeTenants: tenantStats.activeTenants,
        totalUsers: tenantStats.totalUsers,
        systemStatus: systemHealth.status,
      },
      apiMetrics: {
        requestsLastHour: apiMetrics.totalRequests,
        avgResponseTime: apiMetrics.avgResponseTime,
        errorRate: apiMetrics.errorRate,
      },
      errors: {
        totalLastHour: errorStats.total,
        critical: errorStats.bySeverity.critical,
      },
      system: {
        status: systemHealth.status,
        database: systemHealth.database,
        uptime: systemHealth.uptime,
      },
    },
  });
}));

// ============================================================================
// API METRICS
// ============================================================================

router.get('/metrics', asyncHandler(async (req: Request, res: Response) => {
  const minutes = parseInt(req.query.minutes as string) || 60;
  const summary = ApiMetricsService.getInstance().getSummary(minutes);
  res.json({ success: true, data: summary });
}));

router.get('/metrics/timeseries', asyncHandler(async (req: Request, res: Response) => {
  const minutes = parseInt(req.query.minutes as string) || 60;
  const timeSeries = ApiMetricsService.getInstance().getTimeSeries(minutes);
  res.json({ success: true, data: timeSeries });
}));

router.get('/metrics/slow-requests', asyncHandler(async (req: Request, res: Response) => {
  const threshold = parseInt(req.query.threshold as string) || 1000;
  const limit = parseInt(req.query.limit as string) || 100;
  const slowRequests = ApiMetricsService.getInstance().getSlowRequests(threshold, limit);
  res.json({ success: true, data: slowRequests });
}));

router.get('/metrics/tenant/:tenantId', asyncHandler(async (req: Request, res: Response) => {
  const { tenantId } = req.params;
  const minutes = parseInt(req.query.minutes as string) || 60;
  const metrics = ApiMetricsService.getInstance().getTenantMetrics(tenantId, minutes);
  res.json({ success: true, data: metrics });
}));

// ============================================================================
// QUERY ANALYTICS
// ============================================================================

router.get('/queries', asyncHandler(async (req: Request, res: Response) => {
  const minutes = parseInt(req.query.minutes as string) || 60;
  const analytics = QueryAnalyzerService.getInstance().getAnalytics(minutes);
  res.json({ success: true, data: analytics });
}));

router.get('/queries/slow', asyncHandler(async (req: Request, res: Response) => {
  const limit = parseInt(req.query.limit as string) || 100;
  const slowQueries = QueryAnalyzerService.getInstance().getSlowQueries(limit);
  res.json({ success: true, data: slowQueries });
}));

router.post('/queries/analyze', asyncHandler(async (req: Request, res: Response) => {
  const { sql } = req.body;
  if (!sql) {
    res.status(400).json({ success: false, error: 'SQL query required' });
    return;
  }
  const analysis = QueryAnalyzerService.getInstance().analyzeQuery(sql);
  res.json({ success: true, data: analysis });
}));

// ============================================================================
// DATA INTEGRITY
// ============================================================================

router.get('/integrity', asyncHandler(async (_req: Request, res: Response) => {
  const report = OrphanDetectorService.getInstance().getLastScanReport();
  res.json({ success: true, data: report || { message: 'No scan has been run yet' } });
}));

router.post('/integrity/scan', asyncHandler(async (_req: Request, res: Response) => {
  const service = OrphanDetectorService.getInstance();
  if (service.isScanning()) {
    res.status(409).json({ success: false, error: 'Scan already in progress' });
    return;
  }
  const report = await service.runFullScan();
  res.json({ success: true, data: report });
}));

router.get('/integrity/orphans', asyncHandler(async (_req: Request, res: Response) => {
  const orphans = await OrphanDetectorService.getInstance().scanTenantOrphans();
  res.json({ success: true, data: orphans });
}));

// ============================================================================
// ERROR TRACKING
// ============================================================================

router.get('/errors', asyncHandler(async (req: Request, res: Response) => {
  const minutes = parseInt(req.query.minutes as string) || 60;
  const stats = ErrorTrackingService.getInstance().getStats(minutes);
  res.json({ success: true, data: stats });
}));

router.get('/errors/recent', asyncHandler(async (req: Request, res: Response) => {
  const limit = parseInt(req.query.limit as string) || 100;
  const errors = ErrorTrackingService.getInstance().getRecentErrors({ limit });
  res.json({ success: true, data: errors });
}));

router.get('/errors/patterns', asyncHandler(async (req: Request, res: Response) => {
  const patterns = ErrorTrackingService.getInstance().getErrorPatterns({});
  res.json({ success: true, data: patterns });
}));

router.post('/errors/resolve/:fingerprint', asyncHandler(async (req: Request, res: Response) => {
  const { fingerprint } = req.params;
  ErrorTrackingService.getInstance().resolvePattern(fingerprint);
  res.json({ success: true, message: 'Error pattern marked as resolved' });
}));

// ============================================================================
// TENANT MANAGEMENT
// ============================================================================

router.get('/tenants', asyncHandler(async (req: Request, res: Response) => {
  const options = {
    status: req.query.status as string,
    search: req.query.search as string,
    page: parseInt(req.query.page as string) || 1,
    limit: parseInt(req.query.limit as string) || 50,
  };
  const result = await TenantManagementService.getInstance().listTenants(options);
  res.json({ success: true, data: result });
}));

router.get('/tenants/stats', asyncHandler(async (_req: Request, res: Response) => {
  const stats = await TenantManagementService.getInstance().getGlobalStats();
  res.json({ success: true, data: stats });
}));

router.get('/tenants/:tenantId', asyncHandler(async (req: Request, res: Response) => {
  const { tenantId } = req.params;
  const details = await TenantManagementService.getInstance().getTenantDetails(tenantId);
  if (!details) {
    res.status(404).json({ success: false, error: 'Tenant not found' });
    return;
  }
  res.json({ success: true, data: details });
}));

router.post('/tenants', asyncHandler(async (req: Request, res: Response) => {
  const { name, domain, plan, status, settings } = req.body;
  if (!name) {
    res.status(400).json({ success: false, error: 'Tenant name required' });
    return;
  }
  const result = await TenantManagementService.getInstance().createTenant({
    name, domain, plan, status, settings,
  });
  res.status(201).json({ success: true, data: result });
}));

router.put('/tenants/:tenantId', asyncHandler(async (req: Request, res: Response) => {
  const { tenantId } = req.params;
  const { name, domain, plan, settings } = req.body;
  await TenantManagementService.getInstance().updateTenant(tenantId, {
    name, domain, plan, settings,
  });
  res.json({ success: true, message: 'Tenant updated' });
}));

router.post('/tenants/:tenantId/suspend', asyncHandler(async (req: Request, res: Response) => {
  const { tenantId } = req.params;
  const { reason } = req.body;
  await TenantManagementService.getInstance().suspendTenant(tenantId, reason || 'Manual suspension');
  res.json({ success: true, message: 'Tenant suspended' });
}));

router.post('/tenants/:tenantId/reactivate', asyncHandler(async (req: Request, res: Response) => {
  const { tenantId } = req.params;
  await TenantManagementService.getInstance().reactivateTenant(tenantId);
  res.json({ success: true, message: 'Tenant reactivated' });
}));

router.delete('/tenants/:tenantId', asyncHandler(async (req: Request, res: Response) => {
  const { tenantId } = req.params;
  const confirm = req.query.confirm === 'true';
  if (!confirm) {
    res.status(400).json({ success: false, error: 'Add ?confirm=true to confirm deletion' });
    return;
  }
  const result = await TenantManagementService.getInstance().deleteTenant(tenantId, true);
  res.json({ success: true, data: result });
}));

router.get('/tenants/:tenantId/export', asyncHandler(async (req: Request, res: Response) => {
  const { tenantId } = req.params;
  const data = await TenantManagementService.getInstance().exportTenantData(tenantId);
  res.json({ success: true, data });
}));

// ============================================================================
// SYSTEM HEALTH
// ============================================================================

router.get('/health', asyncHandler(async (_req: Request, res: Response) => {
  const report = await SystemHealthService.getInstance().getFullHealthReport();
  res.json({ success: true, data: report });
}));

router.get('/health/database', asyncHandler(async (_req: Request, res: Response) => {
  const [health, stats] = await Promise.all([
    SystemHealthService.getInstance().getDatabaseHealth(),
    SystemHealthService.getInstance().getDatabaseStats(),
  ]);
  res.json({ success: true, data: { health, stats } });
}));

router.get('/health/system', asyncHandler(async (_req: Request, res: Response) => {
  const metrics = SystemHealthService.getInstance().getSystemMetrics();
  res.json({ success: true, data: metrics });
}));

// ============================================================================
// ERROR HANDLER
// ============================================================================

router.use((error: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error('SuperAdmin Error:', error);
  res.status(500).json({
    success: false,
    error: process.env.NODE_ENV === 'production' 
      ? 'Internal server error' 
      : error.message,
  });
});

export { router as SuperAdminRouter };
export default router;
