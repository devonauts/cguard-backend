/**
 * Platform billing records — persistence + sync for the Stripe invoices we
 * charge each TENANT (per-user subscription, implementation fee, recurring
 * cycles). Gives the tenant billing page an invoice history with PDF
 * downloads and gives superadmin the payment record for every tenant.
 *
 * Everything is keyed by stripeInvoiceId, so webhook re-delivery and repeated
 * syncs are harmless upserts (idempotent by construction).
 *
 * (Distinct from billingService.ts / the `invoice` model, which is the
 * tenant→their-clients invoicing feature.)
 */

function toDate(epochSeconds: any): Date | null {
  const n = Number(epochSeconds);
  return n > 0 ? new Date(n * 1000) : null;
}

function summarizeLines(stripeInvoice: any): string | null {
  try {
    const lines = stripeInvoice?.lines?.data;
    if (!Array.isArray(lines) || !lines.length) return null;
    const parts = lines
      .map((l: any) => l?.description || l?.price?.nickname || null)
      .filter(Boolean);
    return parts.length ? parts.join(' · ').slice(0, 2000) : null;
  } catch {
    return null;
  }
}

/** Resolve which tenant a Stripe invoice belongs to. */
export async function resolveTenantIdForInvoice(
  db: any,
  stripeInvoice: any,
): Promise<string | null> {
  // Explicit metadata wins (set on subscription_data at checkout).
  const metaTenantId =
    stripeInvoice?.subscription_details?.metadata?.tenantId ||
    stripeInvoice?.metadata?.tenantId ||
    null;
  if (metaTenantId) return metaTenantId;

  const customerId =
    typeof stripeInvoice?.customer === 'string'
      ? stripeInvoice.customer
      : stripeInvoice?.customer?.id;
  if (!customerId) return null;

  const tenant = await db.tenant.findOne({
    where: { planStripeCustomerId: customerId },
    attributes: ['id'],
  });
  return tenant ? tenant.id : null;
}

/**
 * Upsert one Stripe invoice object into platformInvoices.
 * Returns the row, or null when the invoice can't be tied to a tenant.
 */
export async function upsertInvoiceFromStripe(
  db: any,
  stripeInvoice: any,
  knownTenantId?: string | null,
): Promise<any | null> {
  if (!stripeInvoice || !stripeInvoice.id) return null;

  const tenantId =
    knownTenantId || (await resolveTenantIdForInvoice(db, stripeInvoice));
  if (!tenantId) return null;

  const customerId =
    typeof stripeInvoice.customer === 'string'
      ? stripeInvoice.customer
      : stripeInvoice.customer?.id || null;
  const subscriptionId =
    typeof stripeInvoice.subscription === 'string'
      ? stripeInvoice.subscription
      : stripeInvoice.subscription?.id || null;

  const values = {
    tenantId,
    stripeInvoiceId: stripeInvoice.id,
    stripeCustomerId: customerId,
    stripeSubscriptionId: subscriptionId,
    number: stripeInvoice.number || null,
    status: stripeInvoice.status || 'open',
    amountDueCents: Number(stripeInvoice.amount_due) || 0,
    amountPaidCents: Number(stripeInvoice.amount_paid) || 0,
    currency: (stripeInvoice.currency || 'usd').toLowerCase(),
    periodStart: toDate(stripeInvoice.period_start),
    periodEnd: toDate(stripeInvoice.period_end),
    hostedInvoiceUrl: stripeInvoice.hosted_invoice_url || null,
    invoicePdfUrl: stripeInvoice.invoice_pdf || null,
    linesSummary: summarizeLines(stripeInvoice),
    paidAt: toDate(stripeInvoice.status_transitions?.paid_at),
    issuedAt: toDate(stripeInvoice.created),
  };

  const [row, created] = await db.platformInvoice.findOrCreate({
    where: { stripeInvoiceId: stripeInvoice.id },
    defaults: values,
  });
  if (!created) await row.update(values);
  return row;
}

/**
 * Pull the tenant's invoices from Stripe and upsert them (best-effort cache
 * refresh). Safe to call often; failures are the caller's choice to surface.
 */
export async function syncTenantInvoicesFromStripe(
  db: any,
  tenant: any,
  stripe: any,
): Promise<number> {
  const customerId = tenant?.planStripeCustomerId;
  if (!stripe || !customerId) return 0;

  const res = await stripe.invoices.list({ customer: customerId, limit: 50 });
  const invoices = (res && res.data) || [];
  let count = 0;
  for (const inv of invoices) {
    const row = await upsertInvoiceFromStripe(db, inv, tenant.id);
    if (row) count++;
  }
  return count;
}

export interface PlatformInvoiceView {
  id: string;
  stripeInvoiceId: string;
  number: string | null;
  status: string;
  amountDueCents: number;
  amountPaidCents: number;
  currency: string;
  periodStart: string | null;
  periodEnd: string | null;
  hostedInvoiceUrl: string | null;
  invoicePdfUrl: string | null;
  linesSummary: string | null;
  paidAt: string | null;
  issuedAt: string | null;
}

function serialize(row: any): PlatformInvoiceView {
  const iso = (d: any) => (d ? new Date(d).toISOString() : null);
  return {
    id: row.id,
    stripeInvoiceId: row.stripeInvoiceId,
    number: row.number,
    status: row.status,
    amountDueCents: row.amountDueCents,
    amountPaidCents: row.amountPaidCents,
    currency: row.currency,
    periodStart: iso(row.periodStart),
    periodEnd: iso(row.periodEnd),
    hostedInvoiceUrl: row.hostedInvoiceUrl,
    invoicePdfUrl: row.invoicePdfUrl,
    linesSummary: row.linesSummary,
    paidAt: iso(row.paidAt),
    issuedAt: iso(row.issuedAt),
  };
}

/** Invoice history for one tenant, newest first. */
export async function listTenantInvoices(
  db: any,
  tenantId: string,
): Promise<PlatformInvoiceView[]> {
  const rows = await db.platformInvoice.findAll({
    where: { tenantId },
    order: [['issuedAt', 'DESC'], ['createdAt', 'DESC']],
    limit: 100,
  });
  return rows.map(serialize);
}

/** Recent payments across ALL tenants (superadmin feed), newest first. */
export async function listRecentInvoices(
  db: any,
  opts: { page?: number; limit?: number; status?: string } = {},
): Promise<{ rows: (PlatformInvoiceView & { tenantName: string | null })[]; count: number }> {
  const limit = Math.min(Math.max(Number(opts.limit) || 20, 1), 100);
  const page = Math.max(Number(opts.page) || 1, 1);
  const where: any = {};
  if (opts.status) where.status = opts.status;

  const { rows, count } = await db.platformInvoice.findAndCountAll({
    where,
    order: [['issuedAt', 'DESC'], ['createdAt', 'DESC']],
    limit,
    offset: (page - 1) * limit,
  });

  // Attach tenant names without an association (models are auto-loaded flat).
  const tenantIds = [...new Set(rows.map((r: any) => r.tenantId))];
  const tenants = tenantIds.length
    ? await db.tenant.findAll({ where: { id: tenantIds }, attributes: ['id', 'name'], paranoid: false })
    : [];
  const nameById: Record<string, string> = {};
  tenants.forEach((t: any) => { nameById[t.id] = t.name; });

  return {
    rows: rows.map((r: any) => ({
      ...serialize(r),
      tenantId: r.tenantId,
      tenantName: nameById[r.tenantId] || null,
    })) as any,
    count,
  };
}
