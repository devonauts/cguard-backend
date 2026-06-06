/**
 * SuperAdmin · cross-tenant USERS service.
 *
 * Implements CONTRACT §1 "Users". These run cross-tenant: no tenant filter is
 * applied. Logic lives here; the route module (`src/api/superadmin/users.ts`)
 * stays thin.
 *
 * Association aliases (verified against the model associate() blocks):
 *  - tenantUser.belongsTo(tenant)            → default alias `tenant`
 *  - tenantUser.belongsTo(user)              → default alias `user`
 *    (tenantUser also has belongsTo(user,{as:'createdBy'|'updatedBy'}); we use
 *     the unaliased one, which Sequelize keys as `user`.)
 *  - securityGuard.belongsTo(tenant,{as:'tenant'}) → alias `tenant`
 */
import { Request } from 'express';
import { db, listParams, writeAudit } from './superadminHelpers';
import SequelizeArrayUtils from '../../database/utils/sequelizeArrayUtils';
import Error400 from '../../errors/Error400';
import Error404 from '../../errors/Error404';

interface Paginated<T> {
  rows: T[];
  count: number;
  page: number;
  limit: number;
  totalPages: number;
}

interface UserRow {
  id: string;
  userId: string;
  fullName: string;
  email: string;
  tenantId: string;
  tenantName: string;
  roles: string[];
  status: string;
  createdAt: any;
}

interface GuardRow {
  id: string;
  fullName: string;
  governmentId: string | null;
  tenantId: string;
  tenantName: string;
  guardType: string | null;
  isOnDuty: boolean;
  createdAt: any;
}

interface CompanyMembership {
  tenantId: string;
  tenantName: string;
  roles: string[];
  status: string;
  billingStatus: string;
  billPaid: boolean;
  suspended: boolean;
}

interface PlatformUserRow {
  id: string;
  email: string;
  fullName: string;
  isSuperadmin: boolean;
  emailVerified: boolean;
  createdAt: any;
  companies: CompanyMembership[];
  companyCount: number;
  /** First company's name, or null when the user belongs to none. */
  primaryCompany: string | null;
  /** Primary company billing status (active|trialing|past_due|…) or null. */
  billingStatus: string | null;
  /** true = a company they belong to has an active (paid) subscription;
   *  false = has companies but none paid; null = no company. */
  billPaid: boolean | null;
}

function paginate<T>(rows: T[], count: number, page: number, limit: number): Paginated<T> {
  return {
    rows,
    count,
    page,
    limit,
    totalPages: Math.max(1, Math.ceil((count || 0) / limit)),
  };
}

/** Best-effort fetch of a user record by id (fallback when the include fails). */
async function fetchUser(database: any, userId: string): Promise<any | null> {
  if (!userId) return null;
  try {
    return await database.user.findByPk(userId, {
      attributes: ['id', 'email', 'fullName', 'firstName', 'lastName'],
    });
  } catch {
    return null;
  }
}

/** Best-effort fetch of a tenant name by id (fallback when the include fails). */
async function fetchTenantName(database: any, tenantId: string): Promise<string> {
  if (!tenantId) return '';
  try {
    const t = await database.tenant.findByPk(tenantId, { attributes: ['id', 'name'] });
    return (t && t.name) || '';
  } catch {
    return '';
  }
}

function deriveFullName(u: any): string {
  if (!u) return '';
  if (u.fullName && String(u.fullName).trim()) return String(u.fullName).trim();
  const composed = `${(u.firstName || '').trim()} ${(u.lastName || '').trim()}`.trim();
  return composed;
}

function normalizeRoles(raw: any): string[] {
  if (Array.isArray(raw)) return raw;
  if (raw == null || raw === '') return [];
  if (typeof raw === 'string') {
    // JSON dialects may surface the array as a serialized string.
    if (raw.startsWith('[') && raw.endsWith(']')) {
      try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [raw];
      } catch {
        return [raw];
      }
    }
    return [raw];
  }
  return [];
}

/** Map a (possibly include-hydrated) tenantUser instance to a UserRow. */
async function toUserRow(database: any, tu: any): Promise<UserRow> {
  let user = tu.user;
  if (!user) user = await fetchUser(database, tu.userId);

  let tenantName = tu.tenant ? tu.tenant.name : undefined;
  if (tenantName == null) tenantName = await fetchTenantName(database, tu.tenantId);

  return {
    id: tu.id,
    userId: tu.userId,
    fullName: deriveFullName(user),
    email: (user && user.email) || '',
    tenantId: tu.tenantId,
    tenantName: tenantName || '',
    roles: normalizeRoles(tu.roles),
    status: tu.status,
    createdAt: tu.createdAt,
  };
}

/**
 * GET /users — paginated cross-tenant list of tenantUsers.
 * Filters: search (user email/firstName/lastName), tenantId, role, status.
 */
export async function listUsers(req: Request): Promise<Paginated<UserRow>> {
  const database = db(req);
  const Op = database.Sequelize.Op;
  const { page, limit, offset, search } = listParams(req.query);
  const tenantId = (req.query as any)?.tenantId;
  const role = (req.query as any)?.role;
  const status = (req.query as any)?.status;

  const where: any = {};
  if (tenantId) where.tenantId = tenantId;
  if (status) where.status = status;
  if (role) {
    // Cross-dialect "roles array contains role" via the shared helper.
    Object.assign(where, SequelizeArrayUtils.filter('tenantUser', 'roles', role));
  }

  // search matches the related user's email / firstName / lastName.
  const userWhere = search
    ? {
        [Op.or]: [
          { email: { [Op.like]: `%${search}%` } },
          { firstName: { [Op.like]: `%${search}%` } },
          { lastName: { [Op.like]: `%${search}%` } },
          { fullName: { [Op.like]: `%${search}%` } },
        ],
      }
    : undefined;

  // Primary path: include user (required when searching) + tenant for names.
  try {
    const { rows, count } = await database.tenantUser.findAndCountAll({
      where,
      include: [
        {
          model: database.user,
          required: !!search,
          where: userWhere,
          attributes: ['id', 'email', 'fullName', 'firstName', 'lastName'],
        },
        {
          model: database.tenant,
          required: false,
          attributes: ['id', 'name'],
        },
      ],
      order: [['createdAt', 'DESC']],
      limit,
      offset,
      distinct: true,
      subQuery: false,
    });

    const mapped = await Promise.all(rows.map((tu: any) => toUserRow(database, tu)));
    return paginate(mapped, count, page, limit);
  } catch (err: any) {
    // Fallback: the include/alias failed — never crash the list. Query the
    // tenantUser rows alone (dropping the search-on-user filter) and hydrate
    // user/tenant via secondary lookups by id.
    console.warn('superadmin listUsers include failed, falling back:', err?.message || err);
    const { rows, count } = await database.tenantUser.findAndCountAll({
      where,
      order: [['createdAt', 'DESC']],
      limit,
      offset,
    });
    const mapped = await Promise.all(rows.map((tu: any) => toUserRow(database, tu)));
    return paginate(mapped, count, page, limit);
  }
}

/** GET /users/:tenantUserId — single UserRow (404 if missing). */
export async function getUser(req: Request, tenantUserId: string): Promise<UserRow> {
  const database = db(req);

  let tu: any = null;
  try {
    tu = await database.tenantUser.findByPk(tenantUserId, {
      include: [
        { model: database.user, required: false, attributes: ['id', 'email', 'fullName', 'firstName', 'lastName'] },
        { model: database.tenant, required: false, attributes: ['id', 'name'] },
      ],
    });
  } catch (err: any) {
    // Fallback to a plain lookup; names get hydrated in toUserRow.
    console.warn('superadmin getUser include failed, falling back:', err?.message || err);
    tu = await database.tenantUser.findByPk(tenantUserId);
  }

  if (!tu) {
    throw new Error404((req as any).language);
  }

  return toUserRow(database, tu);
}

/** POST /users/:tenantUserId/status — set tenantUser.status (active|archived). */
export async function setUserStatus(
  req: Request,
  tenantUserId: string,
  status: string,
): Promise<{ success: true }> {
  const database = db(req);

  if (!['active', 'archived'].includes(status)) {
    throw new Error400((req as any).language);
  }

  const tu = await database.tenantUser.findByPk(tenantUserId);
  if (!tu) {
    throw new Error404((req as any).language);
  }

  const from = tu.status;
  await tu.update({ status });

  await writeAudit(req, {
    action: 'user.setStatus',
    targetType: 'tenantUser',
    targetId: tu.id,
    tenantId: tu.tenantId,
    statusCode: 200,
    details: { from, to: status },
  });

  return { success: true };
}

/** Map a securityGuard instance to a GuardRow. */
async function toGuardRow(database: any, g: any): Promise<GuardRow> {
  let tenantName = g.tenant ? g.tenant.name : undefined;
  if (tenantName == null) tenantName = await fetchTenantName(database, g.tenantId);

  return {
    id: g.id,
    fullName: g.fullName,
    governmentId: g.governmentId != null ? g.governmentId : null,
    tenantId: g.tenantId,
    tenantName: tenantName || '',
    guardType: g.guardType != null ? g.guardType : null,
    isOnDuty: !!g.isOnDuty,
    createdAt: g.createdAt,
  };
}

/**
 * GET /guards — paginated cross-tenant list of securityGuards.
 * Filters: search (fullName/governmentId), tenantId.
 */
export async function listGuards(req: Request): Promise<Paginated<GuardRow>> {
  const database = db(req);
  const Op = database.Sequelize.Op;
  const { page, limit, offset, search } = listParams(req.query);
  const tenantId = (req.query as any)?.tenantId;

  const where: any = {};
  if (tenantId) where.tenantId = tenantId;
  if (search) {
    where[Op.or] = [
      { fullName: { [Op.like]: `%${search}%` } },
      { governmentId: { [Op.like]: `%${search}%` } },
    ];
  }

  try {
    const { rows, count } = await database.securityGuard.findAndCountAll({
      where,
      include: [
        { model: database.tenant, as: 'tenant', required: false, attributes: ['id', 'name'] },
      ],
      order: [['createdAt', 'DESC']],
      limit,
      offset,
      distinct: true,
      subQuery: false,
    });
    const mapped = await Promise.all(rows.map((g: any) => toGuardRow(database, g)));
    return paginate(mapped, count, page, limit);
  } catch (err: any) {
    console.warn('superadmin listGuards include failed, falling back:', err?.message || err);
    const { rows, count } = await database.securityGuard.findAndCountAll({
      where,
      order: [['createdAt', 'DESC']],
      limit,
      offset,
    });
    const mapped = await Promise.all(rows.map((g: any) => toGuardRow(database, g)));
    return paginate(mapped, count, page, limit);
  }
}

/** A tenant's bill counts as "paid" once its subscription is active. */
function isBillPaid(billingStatus: string | null | undefined): boolean {
  return String(billingStatus || '').toLowerCase() === 'active';
}

/**
 * GET /platform-users — EVERY platform user (not just tenant members), with the
 * company/companies they belong to and whether that company's bill is paid.
 * This is what makes tenant-less accounts (e.g. just-registered users or
 * superadmins) visible in the panel. Filters: search (email/name),
 * hasCompany ('yes'|'no'), billing (active|trialing|past_due|…).
 */
export async function listPlatformUsers(req: Request): Promise<Paginated<PlatformUserRow>> {
  const database = db(req);
  const Op = database.Sequelize.Op;
  const { page, limit, offset, search } = listParams(req.query);
  const hasCompany = (req.query as any)?.hasCompany; // 'yes' | 'no'
  const billingFilter = (req.query as any)?.billing;

  const where: any = {};
  if (search) {
    where[Op.or] = [
      { email: { [Op.like]: `%${search}%` } },
      { firstName: { [Op.like]: `%${search}%` } },
      { lastName: { [Op.like]: `%${search}%` } },
      { fullName: { [Op.like]: `%${search}%` } },
    ];
  }

  const { rows, count } = await database.user.findAndCountAll({
    where,
    attributes: ['id', 'email', 'fullName', 'firstName', 'lastName', 'isSuperadmin', 'emailVerified', 'createdAt'],
    order: [['createdAt', 'DESC']],
    limit,
    offset,
  });

  const userIds = rows.map((u: any) => u.id);

  // One query for all memberships of the page's users, with tenant billing.
  const membershipsByUser: Record<string, CompanyMembership[]> = {};
  if (userIds.length) {
    let memberships: any[] = [];
    try {
      memberships = await database.tenantUser.findAll({
        where: { userId: { [Op.in]: userIds } },
        attributes: ['id', 'userId', 'tenantId', 'roles', 'status'],
        include: [
          {
            model: database.tenant,
            required: false,
            attributes: ['id', 'name', 'billingStatus', 'suspendedAt'],
          },
        ],
      });
    } catch (err: any) {
      console.warn('superadmin listPlatformUsers membership include failed, falling back:', err?.message || err);
      memberships = await database.tenantUser.findAll({
        where: { userId: { [Op.in]: userIds } },
        attributes: ['id', 'userId', 'tenantId', 'roles', 'status'],
      });
    }
    for (const m of memberships) {
      let tenant = m.tenant;
      if (!tenant) {
        try {
          tenant = await database.tenant.findByPk(m.tenantId, {
            attributes: ['id', 'name', 'billingStatus', 'suspendedAt'],
          });
        } catch {
          tenant = null;
        }
      }
      const billingStatus = (tenant && tenant.billingStatus) || 'trialing';
      const membership: CompanyMembership = {
        tenantId: m.tenantId,
        tenantName: (tenant && tenant.name) || '(unknown)',
        roles: normalizeRoles(m.roles),
        status: m.status,
        billingStatus,
        billPaid: isBillPaid(billingStatus),
        suspended: !!(tenant && tenant.suspendedAt),
      };
      (membershipsByUser[m.userId] ||= []).push(membership);
    }
  }

  let mapped: PlatformUserRow[] = rows.map((u: any) => {
    const companies = membershipsByUser[u.id] || [];
    const primary = companies[0] || null;
    return {
      id: u.id,
      email: u.email || '',
      fullName: deriveFullName(u),
      isSuperadmin: !!u.isSuperadmin,
      emailVerified: !!u.emailVerified,
      createdAt: u.createdAt,
      companies,
      companyCount: companies.length,
      primaryCompany: primary ? primary.tenantName : null,
      billingStatus: primary ? primary.billingStatus : null,
      billPaid: companies.length ? companies.some((c) => c.billPaid) : null,
    };
  });

  // Optional in-memory filters (applied after mapping; counts reflect the page).
  if (hasCompany === 'yes') mapped = mapped.filter((u) => u.companyCount > 0);
  if (hasCompany === 'no') mapped = mapped.filter((u) => u.companyCount === 0);
  if (billingFilter) mapped = mapped.filter((u) => u.companies.some((c) => c.billingStatus === billingFilter));

  return paginate(mapped, count, page, limit);
}
