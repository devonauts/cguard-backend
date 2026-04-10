/**
 * Error Tracking Service
 * 
 * Enterprise-grade centralized error tracking and logging.
 * Tracks:
 * - Application errors with full stack traces
 * - Error frequency and patterns
 * - Error attribution by tenant/endpoint/user
 * - Error resolution status
 * 
 * @class ErrorTrackingService
 */

import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';

type ErrorSeverity = 'debug' | 'info' | 'warning' | 'error' | 'critical';

interface TrackedError {
  id: string;
  timestamp: Date;
  message: string;
  stack: string | null;
  code: string | null;
  severity: ErrorSeverity;
  source: string;
  context: {
    tenantId: string | null;
    userId: string | null;
    requestId: string | null;
    endpoint: string | null;
    method: string | null;
    userAgent: string | null;
    ip: string | null;
  };
  fingerprint: string;
  resolved: boolean;
  metadata: Record<string, unknown>;
}

interface ErrorPattern {
  fingerprint: string;
  message: string;
  count: number;
  firstSeen: Date;
  lastSeen: Date;
  severity: ErrorSeverity;
  source: string;
  affectedTenants: Set<string>;
  affectedEndpoints: Set<string>;
  resolved: boolean;
}

interface ErrorStats {
  total: number;
  bySeverity: Record<ErrorSeverity, number>;
  bySource: Record<string, number>;
  byEndpoint: Record<string, number>;
  byTenant: Record<string, number>;
  errorRate: number; // per minute
  topErrors: Array<{
    fingerprint: string;
    message: string;
    count: number;
    severity: ErrorSeverity;
  }>;
}

interface ErrorAlert {
  id: string;
  timestamp: Date;
  type: 'spike' | 'new_error' | 'critical' | 'recurring';
  message: string;
  errorCount: number;
  fingerprint: string | null;
}

// Error Store singleton
class ErrorStore {
  private static instance: ErrorStore;
  private errors: TrackedError[] = [];
  private patterns: Map<string, ErrorPattern> = new Map();
  private readonly maxErrors = 100000;
  private readonly retentionMs = 7 * 24 * 60 * 60 * 1000; // 7 days

  private constructor() {
    setInterval(() => this.cleanup(), 60 * 60 * 1000); // Hourly cleanup
  }

  static getInstance(): ErrorStore {
    if (!ErrorStore.instance) {
      ErrorStore.instance = new ErrorStore();
    }
    return ErrorStore.instance;
  }

  add(error: TrackedError): void {
    this.errors.push(error);
    this.updatePattern(error);

    if (this.errors.length > this.maxErrors) {
      this.errors = this.errors.slice(-this.maxErrors);
    }
  }

  private updatePattern(error: TrackedError): void {
    const existing = this.patterns.get(error.fingerprint);
    
    if (existing) {
      existing.count++;
      existing.lastSeen = error.timestamp;
      if (error.context.tenantId) {
        existing.affectedTenants.add(error.context.tenantId);
      }
      if (error.context.endpoint) {
        existing.affectedEndpoints.add(error.context.endpoint);
      }
    } else {
      const affectedTenants = new Set<string>();
      const affectedEndpoints = new Set<string>();
      
      if (error.context.tenantId) affectedTenants.add(error.context.tenantId);
      if (error.context.endpoint) affectedEndpoints.add(error.context.endpoint);
      
      this.patterns.set(error.fingerprint, {
        fingerprint: error.fingerprint,
        message: error.message,
        count: 1,
        firstSeen: error.timestamp,
        lastSeen: error.timestamp,
        severity: error.severity,
        source: error.source,
        affectedTenants,
        affectedEndpoints,
        resolved: false,
      });
    }
  }

  getErrors(options: {
    since?: Date;
    severity?: ErrorSeverity;
    tenantId?: string;
    endpoint?: string;
    limit?: number;
  }): TrackedError[] {
    let filtered = this.errors;

    if (options.since) {
      filtered = filtered.filter(e => e.timestamp >= options.since!);
    }
    if (options.severity) {
      filtered = filtered.filter(e => e.severity === options.severity);
    }
    if (options.tenantId) {
      filtered = filtered.filter(e => e.context.tenantId === options.tenantId);
    }
    if (options.endpoint) {
      filtered = filtered.filter(e => e.context.endpoint === options.endpoint);
    }

    return filtered.slice(-(options.limit || 1000));
  }

  getPatterns(): ErrorPattern[] {
    return Array.from(this.patterns.values());
  }

  getPattern(fingerprint: string): ErrorPattern | undefined {
    return this.patterns.get(fingerprint);
  }

  resolvePattern(fingerprint: string): void {
    const pattern = this.patterns.get(fingerprint);
    if (pattern) {
      pattern.resolved = true;
    }
  }

  private cleanup(): void {
    const cutoff = new Date(Date.now() - this.retentionMs);
    this.errors = this.errors.filter(e => e.timestamp >= cutoff);
    
    // Cleanup old resolved patterns
    this.patterns.forEach((pattern, key) => {
      if (pattern.resolved && pattern.lastSeen < cutoff) {
        this.patterns.delete(key);
      }
    });
  }

  clear(): void {
    this.errors = [];
    this.patterns.clear();
  }
}

export class ErrorTrackingService extends EventEmitter {
  private static instance: ErrorTrackingService;
  private store: ErrorStore;
  private enabled: boolean = true;
  private alerts: ErrorAlert[] = [];
  private errorCountLastMinute: number = 0;
  private lastMinuteTimestamp: number = Date.now();
  private readonly alertThresholds = {
    spikeMultiplier: 5, // Alert if errors spike 5x
    criticalCount: 1, // Alert on any critical error
    newErrorInProduction: true,
  };

  private constructor() {
    super();
    this.store = ErrorStore.getInstance();
    
    // Reset error rate counter every minute
    setInterval(() => {
      this.errorCountLastMinute = 0;
      this.lastMinuteTimestamp = Date.now();
    }, 60 * 1000);
  }

  static getInstance(): ErrorTrackingService {
    if (!ErrorTrackingService.instance) {
      ErrorTrackingService.instance = new ErrorTrackingService();
    }
    return ErrorTrackingService.instance;
  }

  /**
   * Track an error
   */
  trackError(
    error: Error | string,
    options?: {
      severity?: ErrorSeverity;
      source?: string;
      code?: string;
      tenantId?: string;
      userId?: string;
      requestId?: string;
      endpoint?: string;
      method?: string;
      userAgent?: string;
      ip?: string;
      metadata?: Record<string, unknown>;
    }
  ): string {
    if (!this.enabled) return '';

    const errorObj = error instanceof Error ? error : new Error(error);
    const message = errorObj.message;
    const stack = errorObj.stack || null;
    const fingerprint = this.generateFingerprint(message, stack, options?.source);

    const trackedError: TrackedError = {
      id: uuidv4(),
      timestamp: new Date(),
      message,
      stack,
      code: options?.code || null,
      severity: options?.severity || 'error',
      source: options?.source || 'application',
      context: {
        tenantId: options?.tenantId || null,
        userId: options?.userId || null,
        requestId: options?.requestId || null,
        endpoint: options?.endpoint || null,
        method: options?.method || null,
        userAgent: options?.userAgent || null,
        ip: options?.ip || null,
      },
      fingerprint,
      resolved: false,
      metadata: options?.metadata || {},
    };

    this.store.add(trackedError);
    this.errorCountLastMinute++;

    // Check for alerts
    this.checkAlerts(trackedError);

    // Emit events
    this.emit('error', trackedError);
    if (trackedError.severity === 'critical') {
      this.emit('critical-error', trackedError);
    }

    return trackedError.id;
  }

  /**
   * Get error statistics
   */
  getStats(minutes: number = 60): ErrorStats {
    const since = new Date(Date.now() - minutes * 60 * 1000);
    const errors = this.store.getErrors({ since });

    if (errors.length === 0) {
      return {
        total: 0,
        bySeverity: { debug: 0, info: 0, warning: 0, error: 0, critical: 0 },
        bySource: {},
        byEndpoint: {},
        byTenant: {},
        errorRate: 0,
        topErrors: [],
      };
    }

    const bySeverity: Record<ErrorSeverity, number> = {
      debug: 0, info: 0, warning: 0, error: 0, critical: 0,
    };
    const bySource: Record<string, number> = {};
    const byEndpoint: Record<string, number> = {};
    const byTenant: Record<string, number> = {};

    errors.forEach(e => {
      bySeverity[e.severity]++;
      bySource[e.source] = (bySource[e.source] || 0) + 1;
      if (e.context.endpoint) {
        byEndpoint[e.context.endpoint] = (byEndpoint[e.context.endpoint] || 0) + 1;
      }
      if (e.context.tenantId) {
        byTenant[e.context.tenantId] = (byTenant[e.context.tenantId] || 0) + 1;
      }
    });

    const patterns = this.store.getPatterns()
      .filter(p => p.lastSeen >= since)
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    return {
      total: errors.length,
      bySeverity,
      bySource,
      byEndpoint,
      byTenant,
      errorRate: Math.round((errors.length / minutes) * 100) / 100,
      topErrors: patterns.map(p => ({
        fingerprint: p.fingerprint,
        message: p.message.substring(0, 100),
        count: p.count,
        severity: p.severity,
      })),
    };
  }

  /**
   * Get recent errors
   */
  getRecentErrors(options: {
    limit?: number;
    severity?: ErrorSeverity;
    tenantId?: string;
    endpoint?: string;
    since?: Date;
  } = {}): TrackedError[] {
    return this.store.getErrors({
      ...options,
      since: options.since || new Date(Date.now() - 24 * 60 * 60 * 1000),
    });
  }

  /**
   * Get error patterns
   */
  getErrorPatterns(options: {
    resolved?: boolean;
    minCount?: number;
  } = {}): Array<{
    fingerprint: string;
    message: string;
    count: number;
    firstSeen: Date;
    lastSeen: Date;
    severity: ErrorSeverity;
    source: string;
    affectedTenantsCount: number;
    affectedEndpointsCount: number;
    resolved: boolean;
  }> {
    return this.store.getPatterns()
      .filter(p => {
        if (options.resolved !== undefined && p.resolved !== options.resolved) return false;
        if (options.minCount && p.count < options.minCount) return false;
        return true;
      })
      .map(p => ({
        fingerprint: p.fingerprint,
        message: p.message,
        count: p.count,
        firstSeen: p.firstSeen,
        lastSeen: p.lastSeen,
        severity: p.severity,
        source: p.source,
        affectedTenantsCount: p.affectedTenants.size,
        affectedEndpointsCount: p.affectedEndpoints.size,
        resolved: p.resolved,
      }))
      .sort((a, b) => b.count - a.count);
  }

  /**
   * Get errors by fingerprint
   */
  getErrorsByFingerprint(fingerprint: string, limit: number = 100): TrackedError[] {
    return this.store.getErrors({ limit: 10000 })
      .filter(e => e.fingerprint === fingerprint)
      .slice(-limit);
  }

  /**
   * Mark error pattern as resolved
   */
  resolvePattern(fingerprint: string): void {
    this.store.resolvePattern(fingerprint);
  }

  /**
   * Get active alerts
   */
  getAlerts(since?: Date): ErrorAlert[] {
    const cutoff = since || new Date(Date.now() - 24 * 60 * 60 * 1000);
    return this.alerts.filter(a => a.timestamp >= cutoff);
  }

  /**
   * Get tenant-specific error stats
   */
  getTenantErrorStats(tenantId: string, minutes: number = 60): {
    total: number;
    bySeverity: Record<ErrorSeverity, number>;
    recentErrors: TrackedError[];
    topPatterns: Array<{ message: string; count: number }>;
  } {
    const since = new Date(Date.now() - minutes * 60 * 1000);
    const errors = this.store.getErrors({ tenantId, since });

    const bySeverity: Record<ErrorSeverity, number> = {
      debug: 0, info: 0, warning: 0, error: 0, critical: 0,
    };

    const patternCounts: Record<string, { message: string; count: number }> = {};

    errors.forEach(e => {
      bySeverity[e.severity]++;
      if (!patternCounts[e.fingerprint]) {
        patternCounts[e.fingerprint] = { message: e.message, count: 0 };
      }
      patternCounts[e.fingerprint].count++;
    });

    const topPatterns = Object.values(patternCounts)
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    return {
      total: errors.length,
      bySeverity,
      recentErrors: errors.slice(-20),
      topPatterns,
    };
  }

  /**
   * Enable/disable error tracking
   */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  /**
   * Clear all error data
   */
  clearData(): void {
    this.store.clear();
    this.alerts = [];
  }

  /**
   * Configure alert thresholds
   */
  setAlertThresholds(thresholds: Partial<typeof this.alertThresholds>): void {
    Object.assign(this.alertThresholds, thresholds);
  }

  // Private methods

  private generateFingerprint(message: string, stack: string | null, source?: string): string {
    // Create a stable fingerprint by normalizing the error
    const normalizedMessage = message
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '[UUID]')
      .replace(/\d+/g, '[N]')
      .replace(/'[^']*'/g, '[STR]')
      .substring(0, 200);

    // Extract first frame from stack trace
    let stackFrame = '';
    if (stack) {
      const frames = stack.split('\n').slice(1, 3);
      stackFrame = frames.join('').replace(/:\d+/g, ':[N]');
    }

    const raw = `${source || ''}:${normalizedMessage}:${stackFrame}`;
    
    // Simple hash
    let hash = 0;
    for (let i = 0; i < raw.length; i++) {
      const char = raw.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    
    return `err_${Math.abs(hash).toString(36)}`;
  }

  private checkAlerts(error: TrackedError): void {
    const pattern = this.store.getPattern(error.fingerprint);
    
    // Critical error alert
    if (error.severity === 'critical') {
      this.createAlert('critical', `Critical error: ${error.message}`, 1, error.fingerprint);
    }

    // New error type alert
    if (pattern && pattern.count === 1) {
      this.createAlert('new_error', `New error type detected: ${error.message}`, 1, error.fingerprint);
    }

    // Spike detection (simplified)
    if (this.errorCountLastMinute > 50 && this.errorCountLastMinute % 50 === 0) {
      this.createAlert('spike', `Error spike detected: ${this.errorCountLastMinute} errors in last minute`, this.errorCountLastMinute, null);
    }
  }

  private createAlert(type: ErrorAlert['type'], message: string, errorCount: number, fingerprint: string | null): void {
    const alert: ErrorAlert = {
      id: uuidv4(),
      timestamp: new Date(),
      type,
      message,
      errorCount,
      fingerprint,
    };

    this.alerts.push(alert);
    
    // Keep only recent alerts
    if (this.alerts.length > 1000) {
      this.alerts = this.alerts.slice(-1000);
    }

    this.emit('alert', alert);
  }
}

export default ErrorTrackingService;
