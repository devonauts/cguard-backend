/**
 * SuperAdmin · billing service — cross-tenant billing analytics & rollups.
 *
 * Reuses the platform pricing engine (src/lib/billingModel.ts) and the
 * per-tenant subscription summary (src/services/subscriptionService.ts). All
 * money values are in cents. Queries run cross-tenant (no tenant filter) off
 * the models bag attached to the request.
 *
 * Distinct from src/services/billingService.ts (the customer-invoicing
 * feature); this module powers the platform owner's billing dashboard.
 */
import { Request } from 'express';
import { db, listParams } from './superadminHelpers';
import {
  quote,
  grossPerUserCents,
  platformFeeCents,
} from '../../lib/billingModel';
import { getSummary, trialInfo } from '../../services/subscriptionService';
import Error404 from '../../errors/Error404';

/** Build a tenantId → seat-count map in a single grouped query (avoids N+1). */
async function seatCountsByTenant(database: any): Promise<Record<string, number>> {
  const { fn, col } = database.Sequelize;
  const rows: any[] = await database.tenantUser.findAll({
    attributes: ['tenantId', [fn('COUNT', col('id')), 'c']],
    group: ['tenantId'],
    raw: true,
  });
  const map: Record<string, number> = {};
  for (const r of rows) {
    map[r.tenantId] = parseInt(r.c, 10) || 0;
  }
  return map;
}

/** GET /billing/overview → BillingOverview */
export async function billingOverview(req: Request): Promise<any> {
  const database = db(req);

  const tenants: any[] = await database.tenant.findAll({ raw: true });
  const seatMap = await seatCountsByTenant(database);

  let mrrCents = 0;
  let netMrrCents = 0;
  let payingTenants = 0;
  let trialingTenants = 0;
  let pastDueTenants = 0;
  let activeSeats = 0;

  const byStatus: Record<string, number> = {
    trialing: 0,
    active: 0,
    past_due: 0,
    trial_expired: 0,
    canceled: 0,
  };

  // plan → { mrrCents, tenants }
  const planAcc: Record<string, { mrrCents: number; tenants: number }> = {};

  for (const t of tenants) {
    const status = t.billingStatus || 'trialing';
    if (byStatus[status] === undefined) byStatus[status] = 0;
    byStatus[status] += 1;

    if (status === 'trialing') trialingTenants += 1;
    if (status === 'past_due') pastDueTenants += 1;

    if (status === 'active') {
      const seats = seatMap[t.id] || 0;
      const q = quote(seats, false);
      mrrCents += q.monthlyCents;
      netMrrCents += q.netMonthlyCents;
      payingTenants += 1;
      activeSeats += seats;

      const plan = t.plan || 'free';
      if (!planAcc[plan]) planAcc[plan] = { mrrCents: 0, tenants: 0 };
      planAcc[plan].mrrCents += q.monthlyCents;
      planAcc[plan].tenants += 1;
    }
  }

  const mrrByPlan = Object.keys(planAcc).map((plan) => ({
    plan,
    mrrCents: planAcc[plan].mrrCents,
    tenants: planAcc[plan].tenants,
  }));

  const avgSeatsPerPayingTenant = payingTenants
    ? Math.round(activeSeats / payingTenants)
    : 0;

  return {
    mrrCents,
    arrCents: mrrCents * 12,
    netMrrCents,
    payingTenants,
    trialingTenants,
    pastDueTenants,
    activeSeats,
    avgSeatsPerPayingTenant,
    perUserCents: grossPerUserCents(),
    platformFeeCents: platformFeeCents(),
    byStatus,
    mrrByPlan,
  };
}

/** GET /billing/tenants → Paginated<TenantBillingRow> */
export async function billingTenants(req: Request): Promise<any> {
  const database = db(req);
  const { Op } = database.Sequelize;
  const { page, limit, offset, search } = listParams(req.query);
  const billingStatus = (req.query as any)?.billingStatus
    ? String((req.query as any).billingStatus).trim()
    : '';

  const where: any = {};
  if (billingStatus) where.billingStatus = billingStatus;
  if (search) {
    where[Op.or] = [
      { name: { [Op.like]: `%${search}%` } },
      { email: { [Op.like]: `%${search}%` } },
    ];
  }

  const { rows, count } = await database.tenant.findAndCountAll({
    where,
    order: [['createdAt', 'DESC']],
    limit,
    offset,
    raw: true,
  });

  const seatMap = await seatCountsByTenant(database);

  const data = rows.map((t: any) => {
    const seats = seatMap[t.id] || 0;
    const active = (t.billingStatus || 'trialing') === 'active';
    const implementationPaid = !!t.implementationPaidAt;
    // Active tenants are already paying, so don't re-add the implementation
    // fee; others quote with implementation when it hasn't been paid yet.
    const q = active ? quote(seats, false) : quote(seats, !implementationPaid);
    return {
      id: t.id,
      name: t.name,
      billingStatus: t.billingStatus || 'trialing',
      seats,
      monthlyCents: q.monthlyCents,
      netMonthlyCents: q.netMonthlyCents,
      hasSubscription: !!t.stripeSubscriptionId,
      implementationPaid,
      trial: trialInfo(t),
      stripeCustomerId: t.planStripeCustomerId || null,
      stripeSubscriptionId: t.stripeSubscriptionId || null,
    };
  });

  return {
    rows: data,
    count,
    page,
    limit,
    totalPages: Math.ceil(count / limit) || 1,
  };
}

/** Map an invoice instance/row (with optional includes) to InvoiceRow. */
function toInvoiceRow(inv: any): any {
  return {
    id: inv.id,
    tenantId: inv.tenantId,
    tenantName: inv['tenant.name'] ?? inv.tenant?.name ?? null,
    invoiceNumber: inv.invoiceNumber,
    status: inv.status,
    date: inv.date,
    dueDate: inv.dueDate,
    subtotal: inv.subtotal,
    total: inv.total,
    clientName: inv['client.name'] ?? inv.client?.name ?? null,
  };
}

/** GET /billing/tenants/:id → { tenant, summary, invoices } */
export async function billingTenantDetail(req: Request): Promise<any> {
  const database = db(req);
  const id = (req.params as any).id;

  const tenant = await database.tenant.findByPk(id);
  if (!tenant) {
    throw new Error404((req as any).language);
  }

  const summary = await getSummary(database, tenant);

  const invoices: any[] = await database.invoice.findAll({
    where: { tenantId: id },
    include: [
      { model: database.clientAccount, as: 'client', attributes: ['id', 'name'], required: false },
    ],
    order: [['date', 'DESC']],
    raw: true,
    nest: true,
  });

  return {
    tenant: { id: tenant.id, name: tenant.name, email: tenant.email },
    summary,
    invoices: invoices.map(toInvoiceRow),
  };
}

/** GET /billing/invoices → Paginated<InvoiceRow> */
export async function billingInvoices(req: Request): Promise<any> {
  const database = db(req);
  const { Op } = database.Sequelize;
  const { page, limit, offset, search } = listParams(req.query);
  const status = (req.query as any)?.status ? String((req.query as any).status).trim() : '';
  const tenantId = (req.query as any)?.tenantId ? String((req.query as any).tenantId).trim() : '';

  const where: any = {};
  if (status) where.status = status;
  if (tenantId) where.tenantId = tenantId;
  if (search) {
    where[Op.or] = [
      { invoiceNumber: { [Op.like]: `%${search}%` } },
    ];
  }

  const { rows, count } = await database.invoice.findAndCountAll({
    where,
    include: [
      { model: database.tenant, as: 'tenant', attributes: ['id', 'name'], required: false },
      { model: database.clientAccount, as: 'client', attributes: ['id', 'name'], required: false },
    ],
    order: [['date', 'DESC']],
    limit,
    offset,
    subQuery: false,
    raw: true,
    nest: true,
  });

  return {
    rows: rows.map(toInvoiceRow),
    count,
    page,
    limit,
    totalPages: Math.ceil(count / limit) || 1,
  };
}
