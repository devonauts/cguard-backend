/**
 * Orphan Detector Service
 * 
 * Enterprise data integrity monitoring for multi-tenant SaaS.
 * Detects:
 * - Records with invalid/missing tenantId
 * - Broken foreign key relationships
 * - Orphaned child records
 * - Data inconsistencies
 * 
 * @class OrphanDetectorService
 */

import { Sequelize, QueryTypes, Model, ModelStatic } from 'sequelize';

interface OrphanRecord {
  id: string;
  table: string;
  issue: 'missing_tenant' | 'invalid_tenant' | 'orphaned_fk' | 'inconsistent';
  details: string;
  createdAt: Date | null;
  severity: 'low' | 'medium' | 'high' | 'critical';
}

interface TableIntegrityReport {
  tableName: string;
  totalRecords: number;
  orphanedRecords: number;
  missingTenants: number;
  brokenReferences: number;
  integrityScore: number; // 0-100
  issues: OrphanRecord[];
}

interface ForeignKeyRelation {
  tableName: string;
  columnName: string;
  referencedTable: string;
  referencedColumn: string;
}

interface SystemIntegrityReport {
  scanTimestamp: Date;
  totalTables: number;
  tablesScanned: number;
  totalOrphans: number;
  criticalIssues: number;
  overallHealth: 'healthy' | 'degraded' | 'critical';
  tableReports: TableIntegrityReport[];
  recommendations: string[];
}

export class OrphanDetectorService {
  private static instance: OrphanDetectorService;
  private sequelize: Sequelize | null = null;
  private models: Map<string, ModelStatic<Model>> = new Map();
  private lastScan: SystemIntegrityReport | null = null;
  private scanning: boolean = false;

  private constructor() {}

  static getInstance(): OrphanDetectorService {
    if (!OrphanDetectorService.instance) {
      OrphanDetectorService.instance = new OrphanDetectorService();
    }
    return OrphanDetectorService.instance;
  }

  /**
   * Initialize with Sequelize instance and models
   */
  initialize(sequelize: Sequelize, models: Record<string, ModelStatic<Model>>): void {
    this.sequelize = sequelize;
    Object.entries(models).forEach(([name, model]) => {
      this.models.set(name, model);
    });
  }

  /**
   * Run full system integrity scan
   */
  async runFullScan(): Promise<SystemIntegrityReport> {
    if (this.scanning) {
      throw new Error('Scan already in progress');
    }

    if (!this.sequelize) {
      throw new Error('OrphanDetectorService not initialized');
    }

    this.scanning = true;

    try {
      const tables = await this.getAllTables();
      const tableReports: TableIntegrityReport[] = [];
      let totalOrphans = 0;
      let criticalIssues = 0;

      for (const tableName of tables) {
        const report = await this.scanTable(tableName);
        tableReports.push(report);
        totalOrphans += report.orphanedRecords;
        criticalIssues += report.issues.filter(i => i.severity === 'critical').length;
      }

      const overallHealth = criticalIssues > 10 ? 'critical' : 
                           totalOrphans > 100 ? 'degraded' : 'healthy';

      const recommendations = this.generateRecommendations(tableReports);

      this.lastScan = {
        scanTimestamp: new Date(),
        totalTables: tables.length,
        tablesScanned: tableReports.length,
        totalOrphans,
        criticalIssues,
        overallHealth,
        tableReports,
        recommendations,
      };

      return this.lastScan;
    } finally {
      this.scanning = false;
    }
  }

  /**
   * Scan specific table for orphans
   */
  async scanTable(tableName: string): Promise<TableIntegrityReport> {
    if (!this.sequelize) {
      throw new Error('OrphanDetectorService not initialized');
    }

    const issues: OrphanRecord[] = [];
    let missingTenants = 0;
    let brokenReferences = 0;

    // Get total records
    const countResult = await this.sequelize.query<{ count: number }>(
      `SELECT COUNT(*) as count FROM \`${tableName}\``,
      { type: QueryTypes.SELECT }
    );
    const totalRecords = countResult[0]?.count || 0;

    // Check for missing tenant IDs
    const hasTenantId = await this.columnExists(tableName, 'tenantId');
    if (hasTenantId) {
      const nullTenants = await this.findNullTenants(tableName);
      nullTenants.forEach(record => {
        issues.push({
          id: record.id,
          table: tableName,
          issue: 'missing_tenant',
          details: `Record has NULL tenantId`,
          createdAt: record.createdAt,
          severity: 'high',
        });
        missingTenants++;
      });

      // Check for invalid tenant references
      const invalidTenants = await this.findInvalidTenants(tableName);
      invalidTenants.forEach(record => {
        issues.push({
          id: record.id,
          table: tableName,
          issue: 'invalid_tenant',
          details: `TenantId ${record.tenantId} does not exist`,
          createdAt: record.createdAt,
          severity: 'critical',
        });
      });
    }

    // Check foreign key relationships
    const fkRelations = await this.getForeignKeys(tableName);
    for (const fk of fkRelations) {
      const orphanedFks = await this.findOrphanedFK(tableName, fk);
      orphanedFks.forEach(record => {
        issues.push({
          id: record.id,
          table: tableName,
          issue: 'orphaned_fk',
          details: `${fk.columnName} references non-existent ${fk.referencedTable}.${fk.referencedColumn}`,
          createdAt: record.createdAt,
          severity: 'high',
        });
        brokenReferences++;
      });
    }

    const orphanedRecords = issues.length;
    const integrityScore = totalRecords > 0 
      ? Math.max(0, Math.round((1 - orphanedRecords / totalRecords) * 100))
      : 100;

    return {
      tableName,
      totalRecords,
      orphanedRecords,
      missingTenants,
      brokenReferences,
      integrityScore,
      issues: issues.slice(0, 100), // Limit issues per table
    };
  }

  /**
   * Quick scan for orphaned tenants only
   */
  async scanTenantOrphans(): Promise<{
    totalOrphans: number;
    byTable: Record<string, number>;
  }> {
    if (!this.sequelize) {
      throw new Error('OrphanDetectorService not initialized');
    }

    const tables = await this.getAllTables();
    const byTable: Record<string, number> = {};
    let totalOrphans = 0;

    for (const tableName of tables) {
      const hasTenantId = await this.columnExists(tableName, 'tenantId');
      if (hasTenantId) {
        const nullTenants = await this.findNullTenants(tableName);
        if (nullTenants.length > 0) {
          byTable[tableName] = nullTenants.length;
          totalOrphans += nullTenants.length;
        }
      }
    }

    return { totalOrphans, byTable };
  }

  /**
   * Find records that might be inconsistent across tenant boundaries
   */
  async detectCrossTenantInconsistencies(): Promise<{
    table: string;
    issue: string;
    count: number;
  }[]> {
    if (!this.sequelize) {
      throw new Error('OrphanDetectorService not initialized');
    }

    const inconsistencies: { table: string; issue: string; count: number }[] = [];

    // Check for common cross-tenant issues
    // Example: User accounts linked to wrong tenant's data
    const userTables = ['ClientAccounts', 'Accounts', 'Users'];
    
    for (const table of userTables) {
      const tableExists = (await this.getAllTables()).includes(table);
      if (!tableExists) continue;

      // Check if user's related data has different tenantId
      const query = `
        SELECT COUNT(*) as count FROM \`${table}\` t1
        WHERE EXISTS (
          SELECT 1 FROM Tenants t2 
          WHERE t1.tenantId != t2.id 
          AND t1.tenantId IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM Tenants WHERE id = t1.tenantId)
        )
      `;
      
      try {
        const result = await this.sequelize.query<{ count: number }>(
          query,
          { type: QueryTypes.SELECT }
        );
        
        if (result[0]?.count > 0) {
          inconsistencies.push({
            table,
            issue: 'Records with non-existent tenantId',
            count: result[0].count,
          });
        }
      } catch (error) {
        // Table might not have the expected structure
        continue;
      }
    }

    return inconsistencies;
  }

  /**
   * Get last scan report
   */
  getLastScanReport(): SystemIntegrityReport | null {
    return this.lastScan;
  }

  /**
   * Check if scan is in progress
   */
  isScanning(): boolean {
    return this.scanning;
  }

  /**
   * Clean up orphaned records (use with caution!)
   */
  async cleanupOrphans(
    tableName: string,
    dryRun: boolean = true
  ): Promise<{
    recordsAffected: number;
    action: 'deleted' | 'simulated';
    details: string[];
  }> {
    if (!this.sequelize) {
      throw new Error('OrphanDetectorService not initialized');
    }

    const report = await this.scanTable(tableName);
    const details: string[] = [];

    if (dryRun) {
      details.push(`Would delete ${report.orphanedRecords} orphaned records`);
      report.issues.forEach(issue => {
        details.push(`- ${issue.issue}: ${issue.id}`);
      });

      return {
        recordsAffected: report.orphanedRecords,
        action: 'simulated',
        details,
      };
    }

    // Actually delete orphans
    let deleted = 0;

    // Delete records with null tenantId
    if (await this.columnExists(tableName, 'tenantId')) {
      const result = await this.sequelize.query(
        `DELETE FROM \`${tableName}\` WHERE tenantId IS NULL`,
        { type: QueryTypes.DELETE }
      );
      // result is number of affected rows in MySQL
      deleted += (result as unknown as number) || 0;
      details.push(`Deleted records with NULL tenantId`);
    }

    return {
      recordsAffected: deleted,
      action: 'deleted',
      details,
    };
  }

  // Private helper methods

  private async getAllTables(): Promise<string[]> {
    if (!this.sequelize) return [];

    const result = await this.sequelize.query<{ TABLE_NAME: string }>(
      `SELECT TABLE_NAME FROM information_schema.TABLES 
       WHERE TABLE_SCHEMA = DATABASE() 
       AND TABLE_TYPE = 'BASE TABLE'`,
      { type: QueryTypes.SELECT }
    );

    return result.map(r => r.TABLE_NAME);
  }

  private async columnExists(tableName: string, columnName: string): Promise<boolean> {
    if (!this.sequelize) return false;

    const result = await this.sequelize.query<{ count: number }>(
      `SELECT COUNT(*) as count FROM information_schema.COLUMNS 
       WHERE TABLE_SCHEMA = DATABASE() 
       AND TABLE_NAME = ? 
       AND COLUMN_NAME = ?`,
      { 
        replacements: [tableName, columnName],
        type: QueryTypes.SELECT 
      }
    );

    return result[0]?.count > 0;
  }

  private async findNullTenants(tableName: string): Promise<Array<{ id: string; createdAt: Date | null }>> {
    if (!this.sequelize) return [];

    try {
      const hasId = await this.columnExists(tableName, 'id');
      const hasCreatedAt = await this.columnExists(tableName, 'createdAt');

      const idColumn = hasId ? 'id' : 'PRIMARY KEY';
      const selectColumns = hasId ? 'id' : '1 as id';
      const createdAtSelect = hasCreatedAt ? ', createdAt' : ', NULL as createdAt';

      const result = await this.sequelize.query<{ id: string; createdAt: Date | null }>(
        `SELECT ${selectColumns}${createdAtSelect} FROM \`${tableName}\` WHERE tenantId IS NULL LIMIT 100`,
        { type: QueryTypes.SELECT }
      );

      return result;
    } catch (error) {
      return [];
    }
  }

  private async findInvalidTenants(tableName: string): Promise<Array<{ id: string; tenantId: string; createdAt: Date | null }>> {
    if (!this.sequelize) return [];

    try {
      const result = await this.sequelize.query<{ id: string; tenantId: string; createdAt: Date | null }>(
        `SELECT t.id, t.tenantId, t.createdAt 
         FROM \`${tableName}\` t
         LEFT JOIN Tenants ten ON t.tenantId = ten.id
         WHERE t.tenantId IS NOT NULL AND ten.id IS NULL
         LIMIT 100`,
        { type: QueryTypes.SELECT }
      );

      return result;
    } catch (error) {
      return [];
    }
  }

  private async getForeignKeys(tableName: string): Promise<ForeignKeyRelation[]> {
    if (!this.sequelize) return [];

    try {
      const result = await this.sequelize.query<{
        COLUMN_NAME: string;
        REFERENCED_TABLE_NAME: string;
        REFERENCED_COLUMN_NAME: string;
      }>(
        `SELECT COLUMN_NAME, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME
         FROM information_schema.KEY_COLUMN_USAGE
         WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = ?
         AND REFERENCED_TABLE_NAME IS NOT NULL`,
        {
          replacements: [tableName],
          type: QueryTypes.SELECT,
        }
      );

      return result.map(r => ({
        tableName,
        columnName: r.COLUMN_NAME,
        referencedTable: r.REFERENCED_TABLE_NAME,
        referencedColumn: r.REFERENCED_COLUMN_NAME,
      }));
    } catch (error) {
      return [];
    }
  }

  private async findOrphanedFK(
    tableName: string,
    fk: ForeignKeyRelation
  ): Promise<Array<{ id: string; createdAt: Date | null }>> {
    if (!this.sequelize) return [];

    try {
      const result = await this.sequelize.query<{ id: string; createdAt: Date | null }>(
        `SELECT t.id, t.createdAt
         FROM \`${tableName}\` t
         LEFT JOIN \`${fk.referencedTable}\` ref ON t.\`${fk.columnName}\` = ref.\`${fk.referencedColumn}\`
         WHERE t.\`${fk.columnName}\` IS NOT NULL AND ref.\`${fk.referencedColumn}\` IS NULL
         LIMIT 100`,
        { type: QueryTypes.SELECT }
      );

      return result;
    } catch (error) {
      return [];
    }
  }

  private generateRecommendations(reports: TableIntegrityReport[]): string[] {
    const recommendations: string[] = [];

    const tablesWithOrphans = reports.filter(r => r.orphanedRecords > 0);
    if (tablesWithOrphans.length > 0) {
      recommendations.push(
        `Found ${tablesWithOrphans.length} tables with orphaned records. Review and cleanup recommended.`
      );
    }

    const tablesWithMissingTenants = reports.filter(r => r.missingTenants > 0);
    if (tablesWithMissingTenants.length > 0) {
      recommendations.push(
        `Found ${tablesWithMissingTenants.length} tables with NULL tenantId values. This may cause data visibility issues.`
      );
    }

    const tablesWithBrokenFKs = reports.filter(r => r.brokenReferences > 0);
    if (tablesWithBrokenFKs.length > 0) {
      recommendations.push(
        `Found ${tablesWithBrokenFKs.length} tables with broken foreign key references. Consider enabling ON DELETE CASCADE or manual cleanup.`
      );
    }

    const lowIntegrityTables = reports.filter(r => r.integrityScore < 90);
    if (lowIntegrityTables.length > 0) {
      recommendations.push(
        `Tables with low integrity scores (<90%): ${lowIntegrityTables.map(t => t.tableName).join(', ')}`
      );
    }

    if (recommendations.length === 0) {
      recommendations.push('All tables passed integrity checks. No action required.');
    }

    return recommendations;
  }
}

export default OrphanDetectorService;
