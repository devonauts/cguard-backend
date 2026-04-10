/**
 * SuperAdmin Module - Enterprise SaaS Administration
 * 
 * This module provides platform-level administration capabilities.
 */

import { Sequelize, Model, ModelStatic } from 'sequelize';

// Re-export all superadmin components
export { SuperAdminAuthMiddleware } from './middleware/SuperAdminAuthMiddleware';
export { SuperAdminRouter } from './SuperAdminController';

// Import services
import { OrphanDetectorService } from './services/OrphanDetectorService';
import { TenantManagementService } from './services/TenantManagementService';
import { SystemHealthService } from './services/SystemHealthService';

// Export services
export { ApiMetricsService } from './services/ApiMetricsService';
export { QueryAnalyzerService } from './services/QueryAnalyzerService';
export { OrphanDetectorService } from './services/OrphanDetectorService';
export { ErrorTrackingService } from './services/ErrorTrackingService';
export { TenantManagementService } from './services/TenantManagementService';
export { SystemHealthService } from './services/SystemHealthService';

/**
 * Initialize the SuperAdmin module with database connection
 */
export function initializeSuperAdmin(
  sequelize: Sequelize,
  models: Record<string, ModelStatic<Model>>
): void {
  OrphanDetectorService.getInstance().initialize(sequelize, models);
  TenantManagementService.getInstance().initialize(sequelize, models);
  SystemHealthService.getInstance().initialize(sequelize);
}
