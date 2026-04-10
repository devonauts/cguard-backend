/**
 * Query Analyzer Service
 * 
 * Enterprise-grade database query monitoring and analysis.
 * Tracks:
 * - Query execution times
 * - Slow queries
 * - Query patterns
 * - N+1 detection
 * - Missing indexes
 * 
 * @class QueryAnalyzerService
 */

import { EventEmitter } from 'events';

interface QueryMetric {
  id: string;
  timestamp: Date;
  sql: string;
  normalizedSql: string;
  duration: number;
  rowCount: number;
  tableName: string | null;
  operation: 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE' | 'OTHER';
  isSlow: boolean;
  tenantId: string | null;
  requestPath: string | null;
}

interface QueryPattern {
  normalizedSql: string;
  count: number;
  totalDuration: number;
  avgDuration: number;
  maxDuration: number;
  tables: string[];
  lastSeen: Date;
}

interface SlowQueryReport {
  query: string;
  normalizedQuery: string;
  avgDuration: number;
  maxDuration: number;
  count: number;
  tableName: string | null;
  suggestedIndexes: string[];
}

interface N1QueryDetection {
  pattern: string;
  count: number;
  requestPath: string;
  timestamp: Date;
  severity: 'warning' | 'critical';
}

// Singleton store
class QueryStore {
  private static instance: QueryStore;
  private queries: QueryMetric[] = [];
  private patterns: Map<string, QueryPattern> = new Map();
  private readonly maxQueries = 50000;
  private readonly retentionMs = 24 * 60 * 60 * 1000;

  private constructor() {
    setInterval(() => this.cleanup(), 5 * 60 * 1000);
  }

  static getInstance(): QueryStore {
    if (!QueryStore.instance) {
      QueryStore.instance = new QueryStore();
    }
    return QueryStore.instance;
  }

  add(query: QueryMetric): void {
    this.queries.push(query);
    this.updatePattern(query);

    if (this.queries.length > this.maxQueries) {
      this.queries = this.queries.slice(-this.maxQueries);
    }
  }

  private updatePattern(query: QueryMetric): void {
    const existing = this.patterns.get(query.normalizedSql);
    
    if (existing) {
      existing.count++;
      existing.totalDuration += query.duration;
      existing.avgDuration = existing.totalDuration / existing.count;
      existing.maxDuration = Math.max(existing.maxDuration, query.duration);
      existing.lastSeen = query.timestamp;
    } else {
      this.patterns.set(query.normalizedSql, {
        normalizedSql: query.normalizedSql,
        count: 1,
        totalDuration: query.duration,
        avgDuration: query.duration,
        maxDuration: query.duration,
        tables: query.tableName ? [query.tableName] : [],
        lastSeen: query.timestamp,
      });
    }
  }

  getRecent(minutes: number): QueryMetric[] {
    const cutoff = new Date(Date.now() - minutes * 60 * 1000);
    return this.queries.filter(q => q.timestamp >= cutoff);
  }

  getSlowQueries(thresholdMs: number = 100): QueryMetric[] {
    return this.queries.filter(q => q.duration > thresholdMs);
  }

  getPatterns(): QueryPattern[] {
    return Array.from(this.patterns.values());
  }

  private cleanup(): void {
    const cutoff = new Date(Date.now() - this.retentionMs);
    this.queries = this.queries.filter(q => q.timestamp >= cutoff);
  }

  clear(): void {
    this.queries = [];
    this.patterns.clear();
  }
}

export class QueryAnalyzerService extends EventEmitter {
  private static instance: QueryAnalyzerService;
  private store: QueryStore;
  private enabled: boolean = true;
  private slowQueryThreshold: number = 100; // ms
  private readonly n1DetectionWindow: Map<string, { count: number; timestamp: number }> = new Map();

  private constructor() {
    super();
    this.store = QueryStore.getInstance();
    
    // N+1 detection cleanup
    setInterval(() => this.cleanupN1Detection(), 60 * 1000);
  }

  static getInstance(): QueryAnalyzerService {
    if (!QueryAnalyzerService.instance) {
      QueryAnalyzerService.instance = new QueryAnalyzerService();
    }
    return QueryAnalyzerService.instance;
  }

  /**
   * Track a query execution
   * Call this from Sequelize logging hook
   */
  trackQuery(
    sql: string,
    duration: number,
    options?: {
      rowCount?: number;
      tenantId?: string;
      requestPath?: string;
    }
  ): void {
    if (!this.enabled) return;

    const normalizedSql = this.normalizeSql(sql);
    const tableName = this.extractTableName(sql);
    const operation = this.extractOperation(sql);
    const isSlow = duration > this.slowQueryThreshold;

    const metric: QueryMetric = {
      id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      timestamp: new Date(),
      sql: sql.length > 1000 ? sql.substring(0, 1000) + '...' : sql,
      normalizedSql,
      duration,
      rowCount: options?.rowCount || 0,
      tableName,
      operation,
      isSlow,
      tenantId: options?.tenantId || null,
      requestPath: options?.requestPath || null,
    };

    this.store.add(metric);

    // Emit events
    if (isSlow) {
      this.emit('slow-query', metric);
    }

    // N+1 detection
    this.detectN1(normalizedSql, options?.requestPath || 'unknown');

    this.emit('query', metric);
  }

  /**
   * Get query analytics summary
   */
  getAnalytics(minutes: number = 60): {
    totalQueries: number;
    slowQueries: number;
    avgDuration: number;
    operationDistribution: Record<string, number>;
    tableActivity: Array<{ table: string; count: number; avgDuration: number }>;
    topSlowQueries: SlowQueryReport[];
    n1Detections: N1QueryDetection[];
  } {
    const queries = this.store.getRecent(minutes);
    const patterns = this.store.getPatterns();

    if (queries.length === 0) {
      return {
        totalQueries: 0,
        slowQueries: 0,
        avgDuration: 0,
        operationDistribution: {},
        tableActivity: [],
        topSlowQueries: [],
        n1Detections: [],
      };
    }

    // Operation distribution
    const operationDistribution: Record<string, number> = {};
    const tableStats: Record<string, { count: number; totalDuration: number }> = {};

    queries.forEach(q => {
      operationDistribution[q.operation] = (operationDistribution[q.operation] || 0) + 1;
      
      if (q.tableName) {
        if (!tableStats[q.tableName]) {
          tableStats[q.tableName] = { count: 0, totalDuration: 0 };
        }
        tableStats[q.tableName].count++;
        tableStats[q.tableName].totalDuration += q.duration;
      }
    });

    const tableActivity = Object.entries(tableStats)
      .map(([table, stats]) => ({
        table,
        count: stats.count,
        avgDuration: Math.round((stats.totalDuration / stats.count) * 100) / 100,
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 20);

    // Top slow queries
    const slowPatterns = patterns
      .filter(p => p.avgDuration > this.slowQueryThreshold)
      .sort((a, b) => b.avgDuration - a.avgDuration)
      .slice(0, 20);

    const topSlowQueries: SlowQueryReport[] = slowPatterns.map(p => ({
      query: p.normalizedSql.substring(0, 200),
      normalizedQuery: p.normalizedSql,
      avgDuration: Math.round(p.avgDuration * 100) / 100,
      maxDuration: Math.round(p.maxDuration * 100) / 100,
      count: p.count,
      tableName: p.tables[0] || null,
      suggestedIndexes: this.suggestIndexes(p.normalizedSql),
    }));

    // N+1 detections
    const n1Detections: N1QueryDetection[] = [];
    this.n1DetectionWindow.forEach((data, key) => {
      if (data.count > 10) {
        n1Detections.push({
          pattern: key,
          count: data.count,
          requestPath: 'unknown',
          timestamp: new Date(data.timestamp),
          severity: data.count > 50 ? 'critical' : 'warning',
        });
      }
    });

    return {
      totalQueries: queries.length,
      slowQueries: queries.filter(q => q.isSlow).length,
      avgDuration: Math.round((queries.reduce((a, b) => a + b.duration, 0) / queries.length) * 100) / 100,
      operationDistribution,
      tableActivity,
      topSlowQueries,
      n1Detections: n1Detections.sort((a, b) => b.count - a.count),
    };
  }

  /**
   * Get slow queries list
   */
  getSlowQueries(limit: number = 100): QueryMetric[] {
    return this.store.getSlowQueries(this.slowQueryThreshold)
      .sort((a, b) => b.duration - a.duration)
      .slice(0, limit);
  }

  /**
   * Analyze query for potential issues
   */
  analyzeQuery(sql: string): {
    hasSelectStar: boolean;
    hasNoLimit: boolean;
    hasNoIndex: boolean;
    hasSubquery: boolean;
    complexity: 'low' | 'medium' | 'high';
    suggestions: string[];
  } {
    const normalizedSql = sql.toUpperCase();
    const suggestions: string[] = [];

    const hasSelectStar = /SELECT\s+\*/i.test(sql);
    if (hasSelectStar) {
      suggestions.push('Avoid SELECT * - specify only needed columns');
    }

    const hasNoLimit = normalizedSql.includes('SELECT') && 
                       !normalizedSql.includes('LIMIT') &&
                       !normalizedSql.includes('COUNT');
    if (hasNoLimit) {
      suggestions.push('Consider adding LIMIT clause to prevent large result sets');
    }

    const hasNoIndex = normalizedSql.includes('WHERE') &&
                       (normalizedSql.includes('LIKE \'%') || normalizedSql.includes('OR '));
    if (hasNoIndex) {
      suggestions.push('Query pattern may not use indexes efficiently');
    }

    const hasSubquery = normalizedSql.includes('(SELECT');
    if (hasSubquery) {
      suggestions.push('Contains subquery - consider using JOINs for better performance');
    }

    // Complexity scoring
    let complexityScore = 0;
    if (normalizedSql.includes('JOIN')) complexityScore += 1;
    if (normalizedSql.includes('SUBQUERY') || normalizedSql.includes('(SELECT')) complexityScore += 2;
    if ((normalizedSql.match(/JOIN/g) || []).length > 2) complexityScore += 2;
    if (normalizedSql.includes('GROUP BY')) complexityScore += 1;
    if (normalizedSql.includes('ORDER BY')) complexityScore += 1;
    if (normalizedSql.includes('HAVING')) complexityScore += 1;

    const complexity = complexityScore <= 2 ? 'low' : complexityScore <= 4 ? 'medium' : 'high';

    return {
      hasSelectStar,
      hasNoLimit,
      hasNoIndex,
      hasSubquery,
      complexity,
      suggestions,
    };
  }

  /**
   * Set slow query threshold
   */
  setSlowQueryThreshold(thresholdMs: number): void {
    this.slowQueryThreshold = thresholdMs;
  }

  /**
   * Enable/disable query tracking
   */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  /**
   * Clear all query data
   */
  clearData(): void {
    this.store.clear();
    this.n1DetectionWindow.clear();
  }

  /**
   * Normalize SQL for pattern matching
   */
  private normalizeSql(sql: string): string {
    return sql
      // Remove string literals
      .replace(/'[^']*'/g, '?')
      // Remove numbers
      .replace(/\b\d+\b/g, '?')
      // Remove UUIDs
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '?')
      // Normalize whitespace
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * Extract table name from SQL
   */
  private extractTableName(sql: string): string | null {
    const fromMatch = sql.match(/FROM\s+[`"']?(\w+)[`"']?/i);
    const intoMatch = sql.match(/INTO\s+[`"']?(\w+)[`"']?/i);
    const updateMatch = sql.match(/UPDATE\s+[`"']?(\w+)[`"']?/i);
    
    return fromMatch?.[1] || intoMatch?.[1] || updateMatch?.[1] || null;
  }

  /**
   * Extract operation type
   */
  private extractOperation(sql: string): 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE' | 'OTHER' {
    const trimmed = sql.trim().toUpperCase();
    if (trimmed.startsWith('SELECT')) return 'SELECT';
    if (trimmed.startsWith('INSERT')) return 'INSERT';
    if (trimmed.startsWith('UPDATE')) return 'UPDATE';
    if (trimmed.startsWith('DELETE')) return 'DELETE';
    return 'OTHER';
  }

  /**
   * Detect N+1 query patterns
   */
  private detectN1(normalizedSql: string, requestPath: string): void {
    const key = `${requestPath}:${normalizedSql}`;
    const now = Date.now();
    const existing = this.n1DetectionWindow.get(key);

    if (existing && now - existing.timestamp < 1000) {
      existing.count++;
      if (existing.count === 10) {
        this.emit('n1-detected', {
          pattern: normalizedSql,
          count: existing.count,
          requestPath,
        });
      }
    } else {
      this.n1DetectionWindow.set(key, { count: 1, timestamp: now });
    }
  }

  /**
   * Cleanup N+1 detection window
   */
  private cleanupN1Detection(): void {
    const now = Date.now();
    this.n1DetectionWindow.forEach((data, key) => {
      if (now - data.timestamp > 60000) {
        this.n1DetectionWindow.delete(key);
      }
    });
  }

  /**
   * Suggest indexes based on query pattern
   */
  private suggestIndexes(sql: string): string[] {
    const suggestions: string[] = [];
    const tableName = this.extractTableName(sql);
    
    if (!tableName) return suggestions;

    // Extract WHERE clause columns
    const whereMatch = sql.match(/WHERE\s+(.+?)(?:ORDER|GROUP|LIMIT|$)/i);
    if (whereMatch) {
      const whereClause = whereMatch[1];
      const columnMatches = whereClause.match(/[`"']?(\w+)[`"']?\s*(?:=|>|<|LIKE|IN)/gi);
      
      if (columnMatches) {
        const columns = columnMatches.map(m => m.replace(/[`"'=><\s]|LIKE|IN/gi, '').trim());
        if (columns.length > 0) {
          suggestions.push(`CREATE INDEX idx_${tableName}_${columns.join('_')} ON ${tableName}(${columns.join(', ')})`);
        }
      }
    }

    return suggestions;
  }
}

export default QueryAnalyzerService;
