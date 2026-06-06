/**
 * SuperAdmin · tenants service — cross-tenant business logic for the platform
 * admin "Tenants" module. Routes in src/api/superadmin/tenants.ts stay thin and
 * delegate here. All queries run cross-tenant (no tenant filter) off
 * `req.database`, reusing the shared superadmin helpers and the billing engine.
 */
import { Request } from 'express';
import { db, listParams } from './superadminHelpers';
import { quote } from '../../lib/billingModel';
import { getSummary } from '../subscriptionService';
import Error404 from '../../errors/Error404';
import Error400 from '../../errors/Error400';

/** TenantRow columns we read from the tenant model (kept minimal for the list). */
const ROW_ATTRS = [
  'id',
  'name',
  'url',
  'email',
  'plan',
  'planStatus',
  'billingStatus',
  'suspendedAt',
  'trialEndsAt',
  'createdAt',
];

/** Shape a raw tenant instance into the contract's TenantRow (+ seats/mrr). */
function toTenantRow(t: any, seats: number): any {
  const mrrCents =
    t.billingStatus === 'active' ? quote(seats, false).monthlyCents : 0;
  return {
    id: t.id,
    name: t.name,
    url: t.url ?? null,
    email: t.email ?? null,
    plan: t.plan ?? null,
    planStatus: t.planStatus ?? null,
    billingStatus: t.billingStatus,
    suspendedAt: t.suspendedAt ?? null,
    seats,
    mrrCents,
    trialEndsAt: t.trialEndsAt ?? null,
    createdAt: t.createdAt,
  };
}

/**
 * GET /tenants — paginated list with search/plan/billingStatus filters.
 * search matches name/email/url via LIKE. Returns Paginated<TenantRow>.
 */
export async function listTenants(req: Request): Promise<any> {
  const database = db(req);
  const Op = database.Sequelize.Op;
  const { page, limit, offset, search } = listParams(req.query);
  const { plan, billingStatus } = req.query as any;

  const where: any = {};
  if (plan) where.plan = plan;
  if (billingStatus) where.billingStatus = billingStatus;
  if (search) {
    const like = { [Op.like]: `%${search}%` };
    where[Op.or] = [{ name: like }, { email: like }, { url: like }];
  }

  const { rows: tenants, count } = await database.tenant.findAndCountAll({
    where,
    attributes: ROW_ATTRS,
    order: [['createdAt', 'DESC']],
    limit,
    offset,
  });

  // Seats per tenant = number of tenantUser rows (one billable seat each).
  const rows = await Promise.all(
    tenants.map(async (t: any) => {
      const seats = await database.tenantUser.count({
        where: { tenantId: t.id },
      });
      return toTenantRow(t, seats);
    }),
  );

  return {
    rows,
    count,
    page,
    limit,
    totalPages: Math.max(1, Math.ceil(count / limit)),
  };
}

/** Fetch a tenant instance or throw 404. */
async function findTenantOr404(req: Request, id: string): Promise<any> {
  const tenant = await db(req).tenant.findByPk(id);
  if (!tenant) throw new Error404((req as any).language);
  return tenant;
}

/**
 * Count rows of every tenant-scoped model for a tenant. We iterate all loaded
 * Sequelize models and, for each that declares a `tenantId` attribute, run a
 * scoped count. Counting is best-effort — any model that errors is skipped so
 * one bad table never breaks the whole detail view.
 */
async function tenantScopedCounts(
  database: any,
  tenantId: string,
): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  const models = database.sequelize?.models || {};
  for (const name of Object.keys(models)) {
    const model = models[name];
    try {
      const attrs = model.getAttributes ? model.getAttributes() : {};
      if (!('tenantId' in attrs)) continue;
      counts[name] = await model.count({ where: { tenantId } });
    } catch {
      // Skip models that can't be counted (missing column, view, etc.).
    }
  }
  return counts;
}

/**
 * GET /tenants/:id — full TenantDetail: the row fields plus contact/business
 * fields, stripe ids, per-model counts and the billing summary.
 */
export async function getTenantDetail(req: Request, id: string): Promise<any> {
  const database = db(req);
  const tenant = await findTenantOr404(req, id);

  const seats = await database.tenantUser.count({
    where: { tenantId: tenant.id },
  });
  const row = toTenantRow(tenant, seats);
  const counts = await tenantScopedCounts(database, tenant.id);
  const billing = await getSummary(database, tenant);

  return {
    ...row,
    phone: tenant.phone ?? null,
    address: tenant.address ?? null,
    city: tenant.city ?? null,
    country: tenant.country ?? null,
    timezone: tenant.timezone ?? null,
    taxNumber: tenant.taxNumber ?? null,
    businessTitle: tenant.businessTitle ?? null,
    website: tenant.website ?? null,
    stripeCustomerId: tenant.planStripeCustomerId ?? null,
    stripeSubscriptionId: tenant.stripeSubscriptionId ?? null,
    implementationPaidAt: tenant.implementationPaidAt ?? null,
    suspensionReason: tenant.suspensionReason ?? null,
    counts,
    billing,
  };
}

/** Fields a superadmin may set on create/update (allow-list to avoid mass-assignment). */
const WRITABLE_FIELDS = [
  'name',
  'email',
  'phone',
  'landline',
  'address',
  'addressLine2',
  'postalCode',
  'city',
  'country',
  'taxNumber',
  'businessTitle',
  'plan',
  'timezone',
  'url',
  'website',
  'licenseNumber',
  'extraLines',
];

/** Required NOT-NULL fields (no DB default) for a create. */
const REQUIRED_CREATE_FIELDS = [
  'name',
  'address',
  'phone',
  'email',
  'taxNumber',
  'businessTitle',
];

/** Pick only allow-listed fields from a body. */
function pickWritable(body: any): any {
  const out: any = {};
  for (const f of WRITABLE_FIELDS) {
    if (body && body[f] !== undefined) out[f] = body[f];
  }
  return out;
}

/**
 * POST /tenants — create a tenant. Validates the required NOT-NULL fields up
 * front (clearer than a raw Sequelize notNull violation), then returns the full
 * detail. Returns the created tenant's id alongside the detail payload.
 */
export async function createTenant(req: Request): Promise<any> {
  const body = req.body || {};
  const missing = REQUIRED_CREATE_FIELDS.filter(
    (f) => body[f] === undefined || body[f] === null || body[f] === '',
  );
  if (missing.length) {
    throw new Error400(
      (req as any).language,
      undefined,
      `Missing required fields: ${missing.join(', ')}`,
    );
  }

  const created = await db(req).tenant.create(pickWritable(body));
  const detail = await getTenantDetail(req, created.id);
  return detail;
}

/**
 * PUT /tenants/:id — partial update from the allow-listed fields. 404 if the
 * tenant doesn't exist.
 */
export async function updateTenant(req: Request, id: string): Promise<any> {
  const tenant = await findTenantOr404(req, id);
  const updates = pickWritable(req.body || {});
  await tenant.update(updates);
  return getTenantDetail(req, id);
}

/**
 * POST /tenants/:id/suspend — block tenant access. Records who/why via
 * suspendedAt + suspensionReason. 404 if missing.
 */
export async function suspendTenant(
  req: Request,
  id: string,
  reason?: string,
): Promise<any> {
  const tenant = await findTenantOr404(req, id);
  await tenant.update({
    suspendedAt: new Date(),
    suspensionReason: reason || null,
  });
  return { success: true };
}

/**
 * POST /tenants/:id/reactivate — clear the suspension. 404 if missing.
 */
export async function reactivateTenant(req: Request, id: string): Promise<any> {
  const tenant = await findTenantOr404(req, id);
  await tenant.update({ suspendedAt: null, suspensionReason: null });
  return { success: true };
}

/**
 * DELETE /tenants/:id — soft-delete (paranoid) the tenant only. Does NOT
 * hard-cascade child tables. Requires ?confirm=true. 404 if missing.
 */
export async function deleteTenant(req: Request, id: string): Promise<any> {
  if ((req.query as any).confirm !== 'true') {
    throw new Error400(
      (req as any).language,
      undefined,
      'Deletion requires confirm=true',
    );
  }
  const tenant = await findTenantOr404(req, id);
  await tenant.destroy(); // paranoid soft-delete
  return { success: true, recordsDeleted: 1, tables: ['tenant'] };
}

/**
 * GET /tenants/:id/export — dump the tenant plus every tenant-scoped model's
 * rows (capped per table) as plain objects. Useful for support/GDPR exports.
 * Per-table failures are skipped so one bad model never breaks the export.
 */
export async function exportTenant(req: Request, id: string): Promise<any> {
  const database = db(req);
  const tenant = await findTenantOr404(req, id);

  const PER_TABLE_CAP = 5000;
  const tables: Record<string, any[]> = {};
  const models = database.sequelize?.models || {};

  for (const name of Object.keys(models)) {
    const model = models[name];
    try {
      const attrs = model.getAttributes ? model.getAttributes() : {};
      if (!('tenantId' in attrs)) continue;
      tables[name] = await model.findAll({
        where: { tenantId: tenant.id },
        limit: PER_TABLE_CAP,
        raw: true,
      });
    } catch {
      // Skip tables that can't be dumped.
    }
  }

  return {
    tenant: tenant.get ? tenant.get({ plain: true }) : tenant,
    tables,
    exportedAt: new Date().toISOString(),
  };
}
