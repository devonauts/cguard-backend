/**
 * API Metrics Service
 * 
 * Enterprise-grade API call tracking and analytics.
 * Tracks:
 * - Request/response times
 * - Endpoint usage patterns
 * - Error rates
 * - Throughput metrics
 * - Per-tenant usage
 * 
 * @class ApiMetricsService
 */

import { Request, Response, NextFunction } from 'express';
import { EventEmitter } from 'events';

// Types
interface ApiMetric {
  id: string;
  timestamp: Date;
  method: string;
  path: string;
  statusCode: number;
  responseTime: number;
  requestSize: number;
  responseSize: number;
  tenantId: string | null;
  userId: string | null;
  userAgent: string;
  clientIp: string;
  error: string | null;
  queryCount: number;
  slowQueries: number;
}

interface MetricsSummary {
  totalRequests: number;
  avgResponseTime: number;
  maxResponseTime: number;
  minResponseTime: number;
  p95ResponseTime: number;
  p99ResponseTime: number;
  errorRate: number;
  statusCodeDistribution: Record<string, number>;
  topEndpoints: Array<{ path: string; count: number; avgTime: number }>;
  requestsPerMinute: number;
  tenantActivity: Array<{ tenantId: string; requestCount: number }>;
}

interface TimeSeriesData {
  timestamp: Date;
  requestCount: number;
  avgResponseTime: number;
  errorCount: number;
}

// Singleton metrics store (in production, use Redis or time-series DB)
class MetricsStore {
  private static instance: MetricsStore;
  private metrics: ApiMetric[] = [];
  private readonly maxMetrics = 100000; // Keep last 100K metrics in memory
  private readonly retentionMs = 24 * 60 * 60 * 1000; // 24 hours

  private constructor() {
    // Cleanup old metrics every 5 minutes
    setInterval(() => this.cleanup(), 5 * 60 * 1000);
  }

  static getInstance(): MetricsStore {
    if (!MetricsStore.instance) {
      MetricsStore.instance = new MetricsStore();
    }
    return MetricsStore.instance;
  }

  add(metric: ApiMetric): void {
    this.metrics.push(metric);
    
    // Trim if exceeds max
    if (this.metrics.length > this.maxMetrics) {
      this.metrics = this.metrics.slice(-this.maxMetrics);
    }
  }

  getAll(): ApiMetric[] {
    return [...this.metrics];
  }

  getRecent(minutes: number = 60): ApiMetric[] {
    const cutoff = new Date(Date.now() - minutes * 60 * 1000);
    return this.metrics.filter(m => m.timestamp >= cutoff);
  }

  getByTenant(tenantId: string): ApiMetric[] {
    return this.metrics.filter(m => m.tenantId === tenantId);
  }

  getByEndpoint(path: string): ApiMetric[] {
    return this.metrics.filter(m => m.path === path);
  }

  getErrors(): ApiMetric[] {
    return this.metrics.filter(m => m.statusCode >= 400);
  }

  private cleanup(): void {
    const cutoff = new Date(Date.now() - this.retentionMs);
    this.metrics = this.metrics.filter(m => m.timestamp >= cutoff);
  }

  clear(): void {
    this.metrics = [];
  }
}

// Query tracking for the request context
const requestQueryCounts = new WeakMap<Request, { count: number; slow: number }>();

export class ApiMetricsService extends EventEmitter {
  private static instance: ApiMetricsService;
  private store: MetricsStore;
  private enabled: boolean = true;

  private constructor() {
    super();
    this.store = MetricsStore.getInstance();
  }

  /**
   * Get singleton instance
   */
  static getInstance(): ApiMetricsService {
    if (!ApiMetricsService.instance) {
      ApiMetricsService.instance = new ApiMetricsService();
    }
    return ApiMetricsService.instance;
  }

  /**
   * Express middleware for tracking API calls
   */
  static middleware() {
    const service = ApiMetricsService.getInstance();
    
    return (req: Request, res: Response, next: NextFunction) => {
      if (!service.enabled) return next();

      const startTime = process.hrtime.bigint();
      const startMemory = process.memoryUsage().heapUsed;
      
      // Initialize query counter for this request
      requestQueryCounts.set(req, { count: 0, slow: 0 });

      // Capture original json method to track response size
      const originalJson = res.json.bind(res);
      let responseSize = 0;

      res.json = function(body: any) {
        try {
          responseSize = Buffer.byteLength(JSON.stringify(body));
        } catch (e) {
          responseSize = 0;
        }
        return originalJson(body);
      };

      // Track on response finish
      res.on('finish', () => {
        const endTime = process.hrtime.bigint();
        const responseTimeMs = Number(endTime - startTime) / 1_000_000;
        
        const queryData = requestQueryCounts.get(req) || { count: 0, slow: 0 };
        
        const metric: ApiMetric = {
          id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
          timestamp: new Date(),
          method: req.method,
          path: service.normalizePath(req.originalUrl || req.path),
          statusCode: res.statusCode,
          responseTime: Math.round(responseTimeMs * 100) / 100,
          requestSize: parseInt(req.headers['content-length'] || '0', 10),
          responseSize,
          tenantId: (req as any).currentTenant?.id || null,
          userId: (req as any).currentUser?.id || null,
          userAgent: req.headers['user-agent'] || 'unknown',
          clientIp: service.getClientIp(req),
          error: res.statusCode >= 400 ? (res as any).errorMessage || null : null,
          queryCount: queryData.count,
          slowQueries: queryData.slow,
        };

        service.store.add(metric);
        service.emit('metric', metric);

        // Emit alerts for slow requests
        if (responseTimeMs > 5000) {
          service.emit('slow-request', metric);
        }

        // Emit alerts for errors
        if (res.statusCode >= 500) {
          service.emit('server-error', metric);
        }
      });

      next();
    };
  }

  /**
   * Increment query count for current request
   * Call this from Sequelize hooks
   */
  static trackQuery(req: Request, isSlow: boolean = false): void {
    const data = requestQueryCounts.get(req);
    if (data) {
      data.count++;
      if (isSlow) data.slow++;
    }
  }

  /**
   * Get metrics summary for a time period
   */
  getSummary(minutes: number = 60): MetricsSummary {
    const metrics = this.store.getRecent(minutes);
    
    if (metrics.length === 0) {
      return this.emptyStats();
    }

    const responseTimes = metrics.map(m => m.responseTime).sort((a, b) => a - b);
    const errors = metrics.filter(m => m.statusCode >= 400);
    const statusCodes: Record<string, number> = {};
    const endpointStats: Record<string, { count: number; totalTime: number }> = {};
    const tenantStats: Record<string, number> = {};

    metrics.forEach(m => {
      // Status code distribution
      const statusKey = `${Math.floor(m.statusCode / 100)}xx`;
      statusCodes[statusKey] = (statusCodes[statusKey] || 0) + 1;

      // Endpoint stats
      if (!endpointStats[m.path]) {
        endpointStats[m.path] = { count: 0, totalTime: 0 };
      }
      endpointStats[m.path].count++;
      endpointStats[m.path].totalTime += m.responseTime;

      // Tenant stats
      if (m.tenantId) {
        tenantStats[m.tenantId] = (tenantStats[m.tenantId] || 0) + 1;
      }
    });

    const topEndpoints = Object.entries(endpointStats)
      .map(([path, stats]) => ({
        path,
        count: stats.count,
        avgTime: Math.round((stats.totalTime / stats.count) * 100) / 100,
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 20);

    const tenantActivity = Object.entries(tenantStats)
      .map(([tenantId, requestCount]) => ({ tenantId, requestCount }))
      .sort((a, b) => b.requestCount - a.requestCount)
      .slice(0, 50);

    const totalTime = metrics[metrics.length - 1].timestamp.getTime() - metrics[0].timestamp.getTime();
    const requestsPerMinute = totalTime > 0 
      ? Math.round((metrics.length / (totalTime / 60000)) * 100) / 100
      : metrics.length;

    return {
      totalRequests: metrics.length,
      avgResponseTime: Math.round((responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length) * 100) / 100,
      maxResponseTime: responseTimes[responseTimes.length - 1],
      minResponseTime: responseTimes[0],
      p95ResponseTime: this.percentile(responseTimes, 95),
      p99ResponseTime: this.percentile(responseTimes, 99),
      errorRate: Math.round((errors.length / metrics.length) * 10000) / 100,
      statusCodeDistribution: statusCodes,
      topEndpoints,
      requestsPerMinute,
      tenantActivity,
    };
  }

  /**
   * Get time series data for charts
   */
  getTimeSeries(minutes: number = 60, intervalMinutes: number = 1): TimeSeriesData[] {
    const metrics = this.store.getRecent(minutes);
    const buckets = new Map<number, ApiMetric[]>();
    
    metrics.forEach(m => {
      const bucket = Math.floor(m.timestamp.getTime() / (intervalMinutes * 60 * 1000));
      if (!buckets.has(bucket)) {
        buckets.set(bucket, []);
      }
      buckets.get(bucket)!.push(m);
    });

    return Array.from(buckets.entries())
      .map(([bucket, items]) => ({
        timestamp: new Date(bucket * intervalMinutes * 60 * 1000),
        requestCount: items.length,
        avgResponseTime: Math.round((items.reduce((a, b) => a + b.responseTime, 0) / items.length) * 100) / 100,
        errorCount: items.filter(m => m.statusCode >= 400).length,
      }))
      .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  }

  /**
   * Get slow requests
   */
  getSlowRequests(thresholdMs: number = 1000, limit: number = 100): ApiMetric[] {
    return this.store.getRecent(60)
      .filter(m => m.responseTime > thresholdMs)
      .sort((a, b) => b.responseTime - a.responseTime)
      .slice(0, limit);
  }

  /**
   * Get error metrics
   */
  getErrors(minutes: number = 60): ApiMetric[] {
    return this.store.getRecent(minutes)
      .filter(m => m.statusCode >= 400)
      .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
  }

  /**
   * Get tenant-specific metrics
   */
  getTenantMetrics(tenantId: string, minutes: number = 60): MetricsSummary {
    const allMetrics = this.store.getRecent(minutes);
    const tenantMetrics = allMetrics.filter(m => m.tenantId === tenantId);
    
    if (tenantMetrics.length === 0) {
      return this.emptyStats();
    }

    // Reuse getSummary logic with filtered metrics
    const responseTimes = tenantMetrics.map(m => m.responseTime).sort((a, b) => a - b);
    const errors = tenantMetrics.filter(m => m.statusCode >= 400);

    return {
      totalRequests: tenantMetrics.length,
      avgResponseTime: Math.round((responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length) * 100) / 100,
      maxResponseTime: responseTimes[responseTimes.length - 1],
      minResponseTime: responseTimes[0],
      p95ResponseTime: this.percentile(responseTimes, 95),
      p99ResponseTime: this.percentile(responseTimes, 99),
      errorRate: Math.round((errors.length / tenantMetrics.length) * 10000) / 100,
      statusCodeDistribution: {},
      topEndpoints: [],
      requestsPerMinute: 0,
      tenantActivity: [],
    };
  }

  /**
   * Enable/disable metrics collection
   */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  /**
   * Clear all metrics
   */
  clearMetrics(): void {
    this.store.clear();
  }

  /**
   * Helper: Calculate percentile
   */
  private percentile(sortedArr: number[], p: number): number {
    if (sortedArr.length === 0) return 0;
    const index = Math.ceil((p / 100) * sortedArr.length) - 1;
    return sortedArr[Math.max(0, index)];
  }

  /**
   * Helper: Normalize path (remove IDs for grouping)
   */
  private normalizePath(path: string): string {
    // Remove query string
    const pathWithoutQuery = path.split('?')[0];
    
    // Replace UUIDs with :id placeholder
    return pathWithoutQuery
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ':id')
      .replace(/\/\d+/g, '/:id');
  }

  /**
   * Helper: Get client IP
   */
  private getClientIp(req: Request): string {
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) {
      const ips = (Array.isArray(forwarded) ? forwarded[0] : forwarded).split(',');
      return ips[0].trim();
    }
    return req.socket.remoteAddress || 'unknown';
  }

  /**
   * Helper: Empty stats object
   */
  private emptyStats(): MetricsSummary {
    return {
      totalRequests: 0,
      avgResponseTime: 0,
      maxResponseTime: 0,
      minResponseTime: 0,
      p95ResponseTime: 0,
      p99ResponseTime: 0,
      errorRate: 0,
      statusCodeDistribution: {},
      topEndpoints: [],
      requestsPerMinute: 0,
      tenantActivity: [],
    };
  }
}

export default ApiMetricsService;
