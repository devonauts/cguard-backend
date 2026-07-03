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
  // Previously this ran one count() PER tenant (N+1). Now it's ONE grouped
  // count over just the page's tenant ids, mapped back in JS.
  const ids = tenants.map((t: any) => t.id);
  const seatsById: Record<string, number> = {};
  if (ids.length) {
    const grouped = await database.tenantUser.findAll({
      attributes: [
        'tenantId',
        [database.Sequelize.fn('COUNT', database.Sequelize.col('id')), 'cnt'],
      ],
      where: { tenantId: { [Op.in]: ids } },
      group: ['tenantId'],
      raw: true,
    });
    for (const g of grouped as any[]) {
      seatsById[g.tenantId] = Number(g.cnt) || 0;
    }
  }

  const rows = tenants.map((t: any) =>
    toTenantRow(t, seatsById[t.id] || 0),
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
 * The handful of tenant-scoped models worth counting in the detail view. The
 * previous implementation iterated EVERY loaded Sequelize model (~80+) and ran
 * a scoped count on each that had a `tenantId` column — dozens of COUNT queries
 * per detail open, most of them noise (pivots, audit logs, config tables). This
 * curated allow-list covers the meaningful entities and keeps the `counts`
 * shape, at a fraction of the query cost.
 */
const COUNT_MODELS = [
  'tenantUser',
  'securityGuard',
  'station',
  'businessInfo',
  'incident',
  'videoCamera',
  'alarmPanel',
  'alarmCase',
] as const;

/**
 * Count rows of the curated tenant-scoped models for a tenant. Counting is
 * best-effort — any model that is missing or errors is skipped so one bad
 * table never breaks the whole detail view.
 */
async function tenantScopedCounts(
  database: any,
  tenantId: string,
): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  const models = database.sequelize?.models || {};
  for (const name of COUNT_MODELS) {
    const model = models[name];
    if (!model) continue;
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
    landline: tenant.landline ?? null,
    address: tenant.address ?? null,
    addressLine2: tenant.addressLine2 ?? null,
    postalCode: tenant.postalCode ?? null,
    city: tenant.city ?? null,
    country: tenant.country ?? null,
    latitude: tenant.latitude ?? null,
    longitude: tenant.longitude ?? null,
    timezone: tenant.timezone ?? null,
    taxNumber: tenant.taxNumber ?? null,
    businessTitle: tenant.businessTitle ?? null,
    licenseNumber: tenant.licenseNumber ?? null,
    website: tenant.website ?? null,
    extraLines: tenant.extraLines ?? null,
    logoId: tenant.logoId ?? null,
    // The detail modal reads planStripeCustomerId directly; keep the legacy
    // stripeCustomerId alias too so existing consumers don't break.
    planStripeCustomerId: tenant.planStripeCustomerId ?? null,
    stripeCustomerId: tenant.planStripeCustomerId ?? null,
    stripeSubscriptionId: tenant.stripeSubscriptionId ?? null,
    implementationPaidAt: tenant.implementationPaidAt ?? null,
    suspensionReason: tenant.suspensionReason ?? null,
    updatedAt: tenant.updatedAt ?? null,
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

  // Optional owner-user invite: if an owner block is provided, provision the
  // tenant's first admin and email them an invitation to set a password. This
  // is best-effort — a failure here does NOT roll back the tenant (it already
  // exists); the error is surfaced so the superadmin can retry the invite.
  const owner = body.owner || {};
  if (owner && owner.email) {
    await provisionOwner(req, created, owner);
  }

  const detail = await getTenantDetail(req, created.id);
  return detail;
}

/**
 * Provision a tenant's first admin user + invitation email. Seeds the tenant's
 * built-in roles and default settings first (so the 'admin' role resolves),
 * then delegates to UserCreator (which creates the user, links the tenantUser
 * with the admin role, and sends the invitation email).
 */
async function provisionOwner(req: Request, tenant: any, owner: any): Promise<void> {
  const database = db(req);
  const SettingsService = require('../settingsService').default;
  const { ensureBuiltInRolesForTenant } = require('../roleSync');
  const UserCreator = require('../user/userCreator').default;
  const UserRepository = require('../../database/repositories/userRepository').default;

  // Reject an email already attached to a user (UserCreator can't create dupes).
  const existing = await UserRepository.findByEmailWithoutAvatar(owner.email, req);
  if (existing) {
    throw new Error400((req as any).language, 'auth.emailAlreadyInUse');
  }

  const scoped: any = {
    database,
    currentUser: (req as any).currentUser,
    currentTenant: tenant,
    language: (req as any).language,
    bypassPermissionValidation: true,
  };

  await SettingsService.findOrCreateDefault({ ...scoped });
  await ensureBuiltInRolesForTenant(database, tenant.id, {});

  await new UserCreator(scoped).execute({
    emails: [owner.email],
    firstName: owner.firstName || null,
    lastName: owner.lastName || null,
    roles: ['admin'],
  });
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
 * POST /tenants/:id/extend-trial — push out the free-trial end date.
 * Body accepts EITHER:
 *   { days: <positive int> } — add N days. Base = the LATER of now and the
 *     current trialEndsAt, so extending a still-running trial ADDS to the time
 *     left, while extending an already-expired trial counts from today.
 *   { until: <ISO date> }    — set an absolute new end date (must be future).
 * Reviving an expired/trialing tenant flips billingStatus back to 'trialing' and
 * resets the reminder stage so reminder emails re-fire from the new window. A
 * paying tenant's billingStatus ('active'/'past_due'/'canceled') is left intact.
 */
export async function extendTrial(req: Request, id: string): Promise<any> {
  const tenant = await findTenantOr404(req, id);
  const body = (req.body || {}) as { days?: number | string; until?: string };

  let newEnd: Date;
  if (body.until !== undefined && body.until !== null && body.until !== '') {
    newEnd = new Date(body.until);
    if (isNaN(newEnd.getTime())) {
      throw new Error400((req as any).language, undefined, 'Invalid "until" date');
    }
  } else {
    const days = Number(body.days);
    if (!Number.isFinite(days) || days <= 0 || days > 3650) {
      throw new Error400(
        (req as any).language,
        undefined,
        'Provide "days" (1–3650) or an "until" date',
      );
    }
    const current = tenant.trialEndsAt ? new Date(tenant.trialEndsAt) : null;
    const base =
      current && current.getTime() > Date.now() ? current : new Date();
    newEnd = new Date(base.getTime() + days * 24 * 60 * 60 * 1000);
  }

  if (newEnd.getTime() <= Date.now()) {
    throw new Error400(
      (req as any).language,
      undefined,
      'New trial end must be in the future',
    );
  }

  const updates: any = { trialEndsAt: newEnd, trialReminderStage: 0 };
  // Re-open access if the trial had lapsed; never override a paying/canceled state.
  if (['trial_expired', 'trialing'].includes(tenant.billingStatus)) {
    updates.billingStatus = 'trialing';
  }
  await tenant.update(updates);
  return getTenantDetail(req, id);
}

/** Valid billingStatus values a superadmin may set manually. */
const SETTABLE_BILLING_STATUSES = ['trialing', 'active', 'past_due', 'trial_expired', 'canceled'];

/**
 * POST /tenants/:id/billing-status — manually set a tenant's billingStatus.
 * Lets a superadmin comp/activate a tenant (e.g. paid by wire, or a partner
 * account) or force-cancel one, independent of Stripe. Setting 'active' does
 * NOT create a Stripe subscription — it's a manual override. 404 if missing.
 */
export async function setBillingStatus(
  req: Request,
  id: string,
  status: string,
): Promise<any> {
  if (!SETTABLE_BILLING_STATUSES.includes(status)) {
    throw new Error400(
      (req as any).language,
      undefined,
      `Invalid billingStatus. Allowed: ${SETTABLE_BILLING_STATUSES.join(', ')}`,
    );
  }
  const tenant = await findTenantOr404(req, id);
  const updates: any = { billingStatus: status };
  // Comping a tenant active clears any lingering suspension so they get in.
  if (status === 'active') {
    updates.suspendedAt = null;
    updates.suspensionReason = null;
  }
  await tenant.update(updates);
  return getTenantDetail(req, id);
}

/**
 * POST /tenants/:id/implementation — toggle the one-time implementation-fee
 * paid marker. Body: { paid: boolean }. 404 if missing.
 */
export async function markImplementationPaid(
  req: Request,
  id: string,
  paid: boolean,
): Promise<any> {
  const tenant = await findTenantOr404(req, id);
  await tenant.update({ implementationPaidAt: paid ? new Date() : null });
  return getTenantDetail(req, id);
}

/**
 * PUT /tenants/:id/plan — change a tenant's plan (tier). Validates the plan key
 * exists in the catalog. Kept distinct from updateTenant so the plan change is
 * a first-class, audited action. 404 if tenant missing, 400 if plan unknown.
 */
export async function changePlan(req: Request, id: string, plan: string): Promise<any> {
  const database = db(req);
  if (!plan) {
    throw new Error400((req as any).language, undefined, 'plan is required');
  }
  const known = await database.planCatalog.findOne({ where: { key: plan } });
  if (!known) {
    throw new Error400((req as any).language, undefined, `Unknown plan "${plan}"`);
  }
  const tenant = await findTenantOr404(req, id);
  await tenant.update({ plan });
  return getTenantDetail(req, id);
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
