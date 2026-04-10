/**
 * Tenant Management Service - Simplified
 * 
 * Enterprise tenant lifecycle management for multi-tenant SaaS.
 */

import { Sequelize, QueryTypes, Op, Model, ModelStatic } from 'sequelize';

interface TenantSummary {
  id: string;
  name: string;
  domain: string | null;
  status: 'active' | 'suspended' | 'trial' | 'churned';
  plan: string | null;
  createdAt: Date;
}

interface TenantDetails extends TenantSummary {
  userCount: number;
  tableRowCounts: Record<string, number>;
}

interface TenantCreate {
  name: string;
  domain?: string;
  plan?: string;
  status?: 'active' | 'trial';
  settings?: Record<string, unknown>;
}

export class TenantManagementService {
  private static instance: TenantManagementService;
  private sequelize: Sequelize | null = null;
  private models: Record<string, ModelStatic<Model>> = {};
  private tenantModel: ModelStatic<Model> | null = null;

  private constructor() {}

  static getInstance(): TenantManagementService {
    if (!TenantManagementService.instance) {
      TenantManagementService.instance = new TenantManagementService();
    }
    return TenantManagementService.instance;
  }

  initialize(
    sequelize: Sequelize, 
    models: Record<string, ModelStatic<Model>>,
    tenantModelName: string = 'tenant'
  ): void {
    this.sequelize = sequelize;
    this.models = models;
    this.tenantModel = models[tenantModelName] || null;
  }

  async listTenants(options: {
    status?: string;
    search?: string;
    page?: number;
    limit?: number;
  } = {}): Promise<{
    tenants: TenantSummary[];
    total: number;
    page: number;
    totalPages: number;
  }> {
    if (!this.sequelize || !this.tenantModel) {
      throw new Error('TenantManagementService not initialized');
    }

    const page = options.page || 1;
    const limit = options.limit || 50;
    const offset = (page - 1) * limit;

    const where: Record<string, unknown> = {};
    if (options.status) {
      where.status = options.status;
    }

    const { count, rows } = await this.tenantModel.findAndCountAll({
      where,
      order: [['createdAt', 'DESC']],
      limit,
      offset,
      raw: true,
    });

    const tenants: TenantSummary[] = (rows as unknown as Array<Record<string, unknown>>).map(tenant => ({
      id: String(tenant.id || ''),
      name: String(tenant.name || 'Unknown'),
      domain: tenant.domain ? String(tenant.domain) : null,
      status: (tenant.status as TenantSummary['status']) || 'active',
      plan: tenant.plan ? String(tenant.plan) : null,
      createdAt: new Date(tenant.createdAt as string),
    }));

    return {
      tenants,
      total: count,
      page,
      totalPages: Math.ceil(count / limit),
    };
  }

  async getTenantDetails(tenantId: string): Promise<TenantDetails | null> {
    if (!this.sequelize || !this.tenantModel) {
      throw new Error('TenantManagementService not initialized');
    }

    const tenant = await this.tenantModel.findByPk(tenantId, { raw: true });
    if (!tenant) return null;

    const tenantData = tenant as unknown as Record<string, unknown>;
    const tableRowCounts = await this.getTenantTableCounts(tenantId);

    let userCount = 0;
    const userModel = this.models['ClientAccount'] || this.models['User'];
    if (userModel) {
      try {
        userCount = await userModel.count({ where: { tenantId } });
      } catch (e) {
        // Ignore
      }
    }

    return {
      id: String(tenantData.id || ''),
      name: String(tenantData.name || 'Unknown'),
      domain: tenantData.domain ? String(tenantData.domain) : null,
      status: (tenantData.status as TenantSummary['status']) || 'active',
      plan: tenantData.plan ? String(tenantData.plan) : null,
      createdAt: new Date(tenantData.createdAt as string),
      userCount,
      tableRowCounts,
    };
  }

  async createTenant(data: TenantCreate): Promise<{ id: string; success: boolean }> {
    if (!this.sequelize || !this.tenantModel) {
      throw new Error('TenantManagementService not initialized');
    }

    const tenant = await this.tenantModel.create({
      name: data.name,
      domain: data.domain || null,
      plan: data.plan || 'free',
      status: data.status || 'active',
    } as Record<string, unknown>);

    const createdTenant = tenant as unknown as Record<string, unknown>;
    return {
      id: String(createdTenant.id || ''),
      success: true,
    };
  }

  async updateTenant(tenantId: string, data: Partial<TenantCreate>): Promise<{ success: boolean }> {
    if (!this.sequelize || !this.tenantModel) {
      throw new Error('TenantManagementService not initialized');
    }

    await this.tenantModel.update(data as Record<string, unknown>, {
      where: { id: tenantId },
    });

    return { success: true };
  }

  async suspendTenant(tenantId: string, reason: string): Promise<{ success: boolean }> {
    if (!this.sequelize || !this.tenantModel) {
      throw new Error('TenantManagementService not initialized');
    }

    await this.tenantModel.update(
      { status: 'suspended' } as Record<string, unknown>,
      { where: { id: tenantId } }
    );

    return { success: true };
  }

  async reactivateTenant(tenantId: string): Promise<{ success: boolean }> {
    if (!this.sequelize || !this.tenantModel) {
      throw new Error('TenantManagementService not initialized');
    }

    await this.tenantModel.update(
      { status: 'active' } as Record<string, unknown>,
      { where: { id: tenantId } }
    );

    return { success: true };
  }

  async deleteTenant(tenantId: string, confirm: boolean = false): Promise<{
    success: boolean;
    recordsDeleted: number;
    tables: string[];
  }> {
    if (!confirm) {
      throw new Error('Must confirm tenant deletion');
    }

    if (!this.sequelize || !this.tenantModel) {
      throw new Error('TenantManagementService not initialized');
    }

    let totalDeleted = 0;
    const tables: string[] = [];

    for (const [name, model] of Object.entries(this.models)) {
      try {
        const attributes = model.getAttributes();
        if ('tenantId' in attributes) {
          const deleted = await model.destroy({ where: { tenantId } });
          if (deleted > 0) {
            totalDeleted += deleted;
            tables.push(name);
          }
        }
      } catch (error) {
        continue;
      }
    }

    await this.tenantModel.destroy({ where: { id: tenantId } });
    totalDeleted++;
    tables.push('Tenant');

    return {
      success: true,
      recordsDeleted: totalDeleted,
      tables,
    };
  }

  async getGlobalStats(): Promise<{
    totalTenants: number;
    activeTenants: number;
    trialTenants: number;
    suspendedTenants: number;
    churnedTenants: number;
    newTenantsThisMonth: number;
    avgUsersPerTenant: number;
    totalUsers: number;
  }> {
    if (!this.sequelize || !this.tenantModel) {
      throw new Error('TenantManagementService not initialized');
    }

    const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const totalTenants = await this.tenantModel.count();
    
    let activeTenants = 0;
    let trialTenants = 0;
    let suspendedTenants = 0;
    let churnedTenants = 0;
    let newTenantsThisMonth = 0;
    
    try {
      activeTenants = await this.tenantModel.count({ where: { status: 'active' } });
      trialTenants = await this.tenantModel.count({ where: { status: 'trial' } });
      suspendedTenants = await this.tenantModel.count({ where: { status: 'suspended' } });
      churnedTenants = await this.tenantModel.count({ where: { status: 'churned' } });
      newTenantsThisMonth = await this.tenantModel.count({
        where: { createdAt: { [Op.gte]: monthAgo } },
      });
    } catch (e) {
      // Ignore if status column doesn't exist
    }

    let totalUsers = 0;
    const userModel = this.models['ClientAccount'] || this.models['User'];
    if (userModel) {
      try {
        totalUsers = await userModel.count();
      } catch (e) {
        // Ignore
      }
    }

    return {
      totalTenants,
      activeTenants,
      trialTenants,
      suspendedTenants,
      churnedTenants,
      newTenantsThisMonth,
      avgUsersPerTenant: totalTenants > 0 ? Math.round(totalUsers / totalTenants) : 0,
      totalUsers,
    };
  }

  async exportTenantData(tenantId: string): Promise<{
    tenant: Record<string, unknown>;
    tables: Record<string, unknown[]>;
    exportedAt: Date;
  }> {
    if (!this.sequelize || !this.tenantModel) {
      throw new Error('TenantManagementService not initialized');
    }

    const tenant = await this.tenantModel.findByPk(tenantId, { raw: true });
    if (!tenant) {
      throw new Error('Tenant not found');
    }

    const tables: Record<string, unknown[]> = {};

    for (const [name, model] of Object.entries(this.models)) {
      try {
        const attributes = model.getAttributes();
        if ('tenantId' in attributes) {
          const records = await model.findAll({
            where: { tenantId },
            raw: true,
            limit: 10000,
          });
          if (records.length > 0) {
            tables[name] = records as unknown as unknown[];
          }
        }
      } catch (error) {
        continue;
      }
    }

    return {
      tenant: tenant as unknown as Record<string, unknown>,
      tables,
      exportedAt: new Date(),
    };
  }

  private async getTenantTableCounts(tenantId: string): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};

    for (const [name, model] of Object.entries(this.models)) {
      try {
        const attributes = model.getAttributes();
        if ('tenantId' in attributes) {
          const count = await model.count({ where: { tenantId } });
          counts[name] = count;
        }
      } catch (error) {
        continue;
      }
    }

    return counts;
  }
}

export default TenantManagementService;
