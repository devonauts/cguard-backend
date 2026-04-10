/**
 * Sequelize Query Logging Hook
 * 
 * Custom Sequelize logging function to track all database queries.
 * Integrates with QueryAnalyzerService.
 * 
 * Usage in Sequelize config:
 * const sequelize = new Sequelize({
 *   ...config,
 *   logging: createQueryLogger(),
 *   benchmark: true,
 * });
 * 
 * @module superadmin/hooks
 */

import { QueryAnalyzerService } from '../services/QueryAnalyzerService';

interface QueryLogContext {
  tenantId?: string;
  requestPath?: string;
}

// Global context store for request tracking
const requestContextStore = new Map<string, QueryLogContext>();

/**
 * Set context for current async operation
 */
export function setQueryContext(requestId: string, context: QueryLogContext): void {
  requestContextStore.set(requestId, context);
}

/**
 * Clear context after request completes
 */
export function clearQueryContext(requestId: string): void {
  requestContextStore.delete(requestId);
}

/**
 * Get context for current operation
 */
export function getQueryContext(requestId: string): QueryLogContext | undefined {
  return requestContextStore.get(requestId);
}

/**
 * Create a Sequelize logging function that tracks queries
 * 
 * @param options - Configuration options
 * @returns Logging function for Sequelize
 */
export function createQueryLogger(options: {
  enabled?: boolean;
  logToConsole?: boolean;
  slowQueryThreshold?: number;
} = {}): (sql: string, timing?: number) => void {
  const {
    enabled = true,
    logToConsole = process.env.NODE_ENV === 'development',
    slowQueryThreshold = 100,
  } = options;

  const queryAnalyzer = QueryAnalyzerService.getInstance();
  
  if (slowQueryThreshold) {
    queryAnalyzer.setSlowQueryThreshold(slowQueryThreshold);
  }

  return (sql: string, timing?: number): void => {
    if (!enabled) return;

    const duration = timing || 0;

    // Track the query
    queryAnalyzer.trackQuery(sql, duration, {
      // Context would be set via async local storage in production
    });

    // Console output for development
    if (logToConsole) {
      const timestamp = new Date().toISOString();
      const prefix = duration > slowQueryThreshold ? '🐢 SLOW' : '📝';
      console.log(`${prefix} [${timestamp}] (${duration}ms) ${sql.substring(0, 200)}${sql.length > 200 ? '...' : ''}`);
    }
  };
}

/**
 * Sequelize hook for tracking row counts
 * Add to model hooks for more detailed tracking
 */
export function createAfterFindHook() {
  return (results: unknown[] | unknown): void => {
    const rowCount = Array.isArray(results) ? results.length : (results ? 1 : 0);
    // Could emit row count metrics here
    console.debug(`Query returned ${rowCount} rows`);
  };
}

/**
 * Example Sequelize configuration with query tracking
 */
export const sampleSequelizeConfig = {
  logging: createQueryLogger({
    enabled: true,
    logToConsole: process.env.NODE_ENV !== 'production',
    slowQueryThreshold: 100,
  }),
  benchmark: true, // Required to get timing in logging function
  pool: {
    max: 50,
    min: 10,
    acquire: 30000,
    idle: 10000,
  },
};

export default {
  createQueryLogger,
  setQueryContext,
  clearQueryContext,
  getQueryContext,
};
