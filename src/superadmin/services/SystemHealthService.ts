/**
 * System Health Service
 * 
 * Enterprise system monitoring for multi-tenant SaaS platform.
 * Monitors:
 * - Database connection pool health
 * - Memory and CPU metrics
 * - Service uptime and availability
 * - External dependency health
 * - Performance benchmarks
 * 
 * @class SystemHealthService
 */

import { Sequelize, QueryTypes } from 'sequelize';
import * as os from 'os';

interface HealthStatus {
  status: 'healthy' | 'degraded' | 'critical';
  message: string;
  lastCheck: Date;
}

interface DatabaseHealth {
  status: 'healthy' | 'degraded' | 'critical';
  connectionPool: {
    size: number;
    available: number;
    waiting: number;
    maxSize: number;
  };
  latency: number; // ms
  activeQueries: number;
  slowQueries: number;
  replicationLag: number | null;
  version: string;
  uptime: number; // seconds
}

interface SystemMetrics {
  cpu: {
    usage: number; // percentage
    cores: number;
    loadAverage: number[];
  };
  memory: {
    total: number;
    used: number;
    free: number;
    heapUsed: number;
    heapTotal: number;
    external: number;
    rss: number;
  };
  uptime: {
    system: number;
    process: number;
  };
  eventLoop: {
    lag: number; // ms
  };
}

interface ServiceHealth {
  name: string;
  status: 'healthy' | 'degraded' | 'critical' | 'unknown';
  responseTime: number | null;
  lastCheck: Date;
  details: Record<string, unknown>;
}

interface HealthReport {
  timestamp: Date;
  overall: 'healthy' | 'degraded' | 'critical';
  database: DatabaseHealth;
  system: SystemMetrics;
  services: ServiceHealth[];
  alerts: string[];
  recommendations: string[];
}

export class SystemHealthService {
  private static instance: SystemHealthService;
  private sequelize: Sequelize | null = null;
  private lastHealthReport: HealthReport | null = null;
  private healthCheckInterval: NodeJS.Timeout | null = null;
  private eventLoopLag: number = 0;
  private eventLoopTimer: NodeJS.Timeout | null = null;
  private externalServices: Map<string, () => Promise<ServiceHealth>> = new Map();

  private constructor() {
    this.startEventLoopMonitoring();
  }

  static getInstance(): SystemHealthService {
    if (!SystemHealthService.instance) {
      SystemHealthService.instance = new SystemHealthService();
    }
    return SystemHealthService.instance;
  }

  /**
   * Initialize with Sequelize instance
   */
  initialize(sequelize: Sequelize): void {
    this.sequelize = sequelize;
  }

  /**
   * Register an external service health check
   */
  registerService(name: string, healthCheck: () => Promise<ServiceHealth>): void {
    this.externalServices.set(name, healthCheck);
  }

  /**
   * Start automatic health monitoring
   */
  startAutoMonitoring(intervalMs: number = 60000): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
    }

    this.healthCheckInterval = setInterval(async () => {
      await this.getFullHealthReport();
    }, intervalMs);
  }

  /**
   * Stop automatic health monitoring
   */
  stopAutoMonitoring(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
  }

  /**
   * Get full health report
   */
  async getFullHealthReport(): Promise<HealthReport> {
    const [database, system, services] = await Promise.all([
      this.getDatabaseHealth(),
      this.getSystemMetrics(),
      this.checkExternalServices(),
    ]);

    const alerts: string[] = [];
    const recommendations: string[] = [];

    // Check database health
    if (database.status === 'critical') {
      alerts.push('Database health critical');
    } else if (database.status === 'degraded') {
      alerts.push('Database health degraded');
    }

    if (database.connectionPool.waiting > 10) {
      alerts.push(`High connection pool wait queue: ${database.connectionPool.waiting}`);
      recommendations.push('Consider increasing database connection pool size');
    }

    if (database.latency > 100) {
      alerts.push(`High database latency: ${database.latency}ms`);
    }

    // Check system metrics
    if (system.cpu.usage > 80) {
      alerts.push(`High CPU usage: ${system.cpu.usage}%`);
      recommendations.push('Consider scaling horizontally');
    }

    const memoryUsagePercent = (system.memory.used / system.memory.total) * 100;
    if (memoryUsagePercent > 85) {
      alerts.push(`High memory usage: ${memoryUsagePercent.toFixed(1)}%`);
    }

    const heapUsagePercent = (system.memory.heapUsed / system.memory.heapTotal) * 100;
    if (heapUsagePercent > 90) {
      alerts.push(`High heap memory usage: ${heapUsagePercent.toFixed(1)}%`);
      recommendations.push('Review memory leaks or increase heap size');
    }

    if (system.eventLoop.lag > 100) {
      alerts.push(`High event loop lag: ${system.eventLoop.lag}ms`);
      recommendations.push('Review blocking operations in code');
    }

    // Check services
    const unhealthyServices = services.filter(s => s.status !== 'healthy');
    unhealthyServices.forEach(s => {
      alerts.push(`Service ${s.name} is ${s.status}`);
    });

    // Determine overall health
    let overall: 'healthy' | 'degraded' | 'critical' = 'healthy';
    if (database.status === 'critical' || services.some(s => s.status === 'critical')) {
      overall = 'critical';
    } else if (
      database.status === 'degraded' || 
      alerts.length > 0 ||
      services.some(s => s.status === 'degraded')
    ) {
      overall = 'degraded';
    }

    this.lastHealthReport = {
      timestamp: new Date(),
      overall,
      database,
      system,
      services,
      alerts,
      recommendations,
    };

    return this.lastHealthReport;
  }

  /**
   * Get database health
   */
  async getDatabaseHealth(): Promise<DatabaseHealth> {
    if (!this.sequelize) {
      return {
        status: 'critical',
        connectionPool: { size: 0, available: 0, waiting: 0, maxSize: 0 },
        latency: 0,
        activeQueries: 0,
        slowQueries: 0,
        replicationLag: null,
        version: 'unknown',
        uptime: 0,
      };
    }

    try {
      // Measure query latency
      const startTime = Date.now();
      await this.sequelize.query('SELECT 1', { type: QueryTypes.SELECT });
      const latency = Date.now() - startTime;

      // Get pool stats (Sequelize doesn't expose this directly, so we estimate)
      const poolConfig = (this.sequelize as unknown as { config?: { pool?: { max: number; min: number } } })
        .config?.pool || { max: 5, min: 0 };

      // Get MySQL version and uptime
      let version = 'unknown';
      let uptime = 0;
      let activeQueries = 0;
      let slowQueries = 0;

      try {
        const versionResult = await this.sequelize.query<{ version: string }>(
          'SELECT VERSION() as version',
          { type: QueryTypes.SELECT }
        );
        version = versionResult[0]?.version || 'unknown';

        const statusResult = await this.sequelize.query<{ Variable_name: string; Value: string }>(
          "SHOW GLOBAL STATUS WHERE Variable_name IN ('Uptime', 'Threads_running', 'Slow_queries')",
          { type: QueryTypes.SELECT }
        );

        statusResult.forEach(row => {
          if (row.Variable_name === 'Uptime') uptime = parseInt(row.Value, 10);
          if (row.Variable_name === 'Threads_running') activeQueries = parseInt(row.Value, 10);
          if (row.Variable_name === 'Slow_queries') slowQueries = parseInt(row.Value, 10);
        });
      } catch (e) {
        // Ignore errors getting extended info
      }

      // Determine status
      let status: DatabaseHealth['status'] = 'healthy';
      if (latency > 500) {
        status = 'critical';
      } else if (latency > 100 || activeQueries > 50) {
        status = 'degraded';
      }

      return {
        status,
        connectionPool: {
          size: poolConfig.max,
          available: poolConfig.max, // Estimate
          waiting: 0, // Can't get from Sequelize directly
          maxSize: poolConfig.max,
        },
        latency,
        activeQueries,
        slowQueries,
        replicationLag: null, // Would need replica setup
        version,
        uptime,
      };
    } catch (error) {
      return {
        status: 'critical',
        connectionPool: { size: 0, available: 0, waiting: 0, maxSize: 0 },
        latency: 0,
        activeQueries: 0,
        slowQueries: 0,
        replicationLag: null,
        version: 'unknown',
        uptime: 0,
      };
    }
  }

  /**
   * Get system metrics
   */
  getSystemMetrics(): SystemMetrics {
    const cpus = os.cpus();
    const memInfo = process.memoryUsage();
    const totalMem = os.totalmem();
    const freeMem = os.freemem();

    // Calculate CPU usage
    let cpuUsage = 0;
    cpus.forEach(cpu => {
      const total = Object.values(cpu.times).reduce((a, b) => a + b, 0);
      const idle = cpu.times.idle;
      cpuUsage += ((total - idle) / total) * 100;
    });
    cpuUsage = cpuUsage / cpus.length;

    return {
      cpu: {
        usage: Math.round(cpuUsage * 100) / 100,
        cores: cpus.length,
        loadAverage: os.loadavg(),
      },
      memory: {
        total: totalMem,
        used: totalMem - freeMem,
        free: freeMem,
        heapUsed: memInfo.heapUsed,
        heapTotal: memInfo.heapTotal,
        external: memInfo.external,
        rss: memInfo.rss,
      },
      uptime: {
        system: os.uptime(),
        process: process.uptime(),
      },
      eventLoop: {
        lag: this.eventLoopLag,
      },
    };
  }

  /**
   * Check external services health
   */
  async checkExternalServices(): Promise<ServiceHealth[]> {
    const results: ServiceHealth[] = [];

    for (const [name, healthCheck] of this.externalServices) {
      try {
        const result = await healthCheck();
        results.push(result);
      } catch (error) {
        results.push({
          name,
          status: 'critical',
          responseTime: null,
          lastCheck: new Date(),
          details: { error: error instanceof Error ? error.message : 'Unknown error' },
        });
      }
    }

    return results;
  }

  /**
   * Get quick health status (for health check endpoints)
   */
  async getQuickHealth(): Promise<{
    status: 'healthy' | 'degraded' | 'critical';
    database: 'connected' | 'disconnected';
    uptime: number;
    memory: { used: number; total: number };
  }> {
    let dbStatus: 'connected' | 'disconnected' = 'disconnected';

    if (this.sequelize) {
      try {
        await this.sequelize.query('SELECT 1', { type: QueryTypes.SELECT });
        dbStatus = 'connected';
      } catch (e) {
        dbStatus = 'disconnected';
      }
    }

    const memInfo = process.memoryUsage();
    const status = dbStatus === 'connected' ? 'healthy' : 'critical';

    return {
      status,
      database: dbStatus,
      uptime: process.uptime(),
      memory: {
        used: memInfo.heapUsed,
        total: memInfo.heapTotal,
      },
    };
  }

  /**
   * Get database connection stats
   */
  async getDatabaseStats(): Promise<{
    connections: {
      active: number;
      total: number;
      maxAllowed: number;
    };
    tables: {
      count: number;
      totalRows: number;
      totalSize: number;
    };
    performance: {
      queriesPerSecond: number;
      slowQueriesPerHour: number;
      avgQueryTime: number;
    };
  }> {
    if (!this.sequelize) {
      throw new Error('SystemHealthService not initialized');
    }

    try {
      // Get connection stats
      const connResult = await this.sequelize.query<{ Variable_name: string; Value: string }>(
        "SHOW GLOBAL STATUS WHERE Variable_name IN ('Threads_connected', 'Max_used_connections', 'Queries', 'Slow_queries')",
        { type: QueryTypes.SELECT }
      );

      const connVarResult = await this.sequelize.query<{ Variable_name: string; Value: string }>(
        "SHOW VARIABLES WHERE Variable_name = 'max_connections'",
        { type: QueryTypes.SELECT }
      );

      const connStats: Record<string, number> = {};
      connResult.forEach(row => {
        connStats[row.Variable_name] = parseInt(row.Value, 10);
      });
      connVarResult.forEach(row => {
        connStats[row.Variable_name] = parseInt(row.Value, 10);
      });

      // Get table stats
      const tableResult = await this.sequelize.query<{ 
        table_count: number; 
        total_rows: number;
        total_size: number;
      }>(
        `SELECT 
          COUNT(*) as table_count,
          SUM(TABLE_ROWS) as total_rows,
          SUM(DATA_LENGTH + INDEX_LENGTH) as total_size
         FROM information_schema.TABLES 
         WHERE TABLE_SCHEMA = DATABASE()`,
        { type: QueryTypes.SELECT }
      );

      return {
        connections: {
          active: connStats['Threads_connected'] || 0,
          total: connStats['Max_used_connections'] || 0,
          maxAllowed: connStats['max_connections'] || 0,
        },
        tables: {
          count: tableResult[0]?.table_count || 0,
          totalRows: tableResult[0]?.total_rows || 0,
          totalSize: tableResult[0]?.total_size || 0,
        },
        performance: {
          queriesPerSecond: 0, // Would need to calculate over time
          slowQueriesPerHour: connStats['Slow_queries'] || 0,
          avgQueryTime: 0,
        },
      };
    } catch (error) {
      throw new Error(`Failed to get database stats: ${error}`);
    }
  }

  /**
   * Get last cached health report
   */
  getLastHealthReport(): HealthReport | null {
    return this.lastHealthReport;
  }

  /**
   * Format bytes to human readable
   */
  formatBytes(bytes: number): string {
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let unitIndex = 0;
    let size = bytes;

    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024;
      unitIndex++;
    }

    return `${size.toFixed(2)} ${units[unitIndex]}`;
  }

  /**
   * Format uptime to human readable
   */
  formatUptime(seconds: number): string {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);

    const parts: string[] = [];
    if (days > 0) parts.push(`${days}d`);
    if (hours > 0) parts.push(`${hours}h`);
    if (minutes > 0) parts.push(`${minutes}m`);

    return parts.join(' ') || '< 1m';
  }

  // Private methods

  private startEventLoopMonitoring(): void {
    const measureLag = () => {
      const start = Date.now();
      setImmediate(() => {
        this.eventLoopLag = Date.now() - start;
      });
    };

    this.eventLoopTimer = setInterval(measureLag, 1000);
  }

  /**
   * Cleanup resources
   */
  destroy(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
    }
    if (this.eventLoopTimer) {
      clearInterval(this.eventLoopTimer);
    }
  }
}

export default SystemHealthService;
