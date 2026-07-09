/**
 * Unit tests — platform billing records (Stripe subscription invoices).
 *
 * Covers services/platformBillingService.ts against an in-memory fake db:
 *  - upsertInvoiceFromStripe maps Stripe invoice fields and is IDEMPOTENT
 *    (re-delivery of the same stripeInvoiceId updates instead of duplicating)
 *  - tenant resolution: subscription metadata first, then planStripeCustomerId,
 *    and unknown customers are skipped (returns null, never throws)
 *  - syncTenantInvoicesFromStripe pulls stripe.invoices.list and upserts
 *  - listTenantInvoices serializes rows newest-first with the PDF links
 *
 * No MySQL, no network — mirrors tests/unit/financial-validation-utils style.
 *
 * Run:
 *   cross-env NODE_ENV=test TS_NODE_PROJECT=tsconfig.test.json \
 *     npx mocha -r ts-node/register \
 *     'tests/unit/platform-billing/platformBilling.test.ts' --exit --timeout 20000
 */

import assert from 'assert';
import sinon from 'sinon';

import {
  upsertInvoiceFromStripe,
  syncTenantInvoicesFromStripe,
  listTenantInvoices,
  resolveTenantIdForInvoice,
} from '../../../src/services/platformBillingService';

// ── Fake db ─────────────────────────────────────────────────────────────────

function makeFakeDb(tenants: any[] = []) {
  const invoices: any[] = [];

  const platformInvoice = {
    rows: invoices,
    async findOrCreate({ where, defaults }: any) {
      const found = invoices.find((r) => r.stripeInvoiceId === where.stripeInvoiceId);
      if (found) {
        return [found, false];
      }
      const row: any = {
        id: `pi_row_${invoices.length + 1}`,
        ...defaults,
        async update(vals: any) {
          Object.assign(row, vals);
          return row;
        },
      };
      invoices.push(row);
      return [row, true];
    },
    async findAll({ where }: any = {}) {
      let out = invoices;
      if (where?.tenantId) out = out.filter((r) => r.tenantId === where.tenantId);
      return out;
    },
    async findAndCountAll() {
      return { rows: invoices, count: invoices.length };
    },
  };

  const tenant = {
    async findOne({ where }: any) {
      return (
        tenants.find((t) => t.planStripeCustomerId === where.planStripeCustomerId) || null
      );
    },
    async findAll({ where }: any) {
      return tenants.filter((t) => (where.id || []).includes(t.id));
    },
  };

  return { platformInvoice, tenant, _invoices: invoices };
}

// A realistic Stripe invoice payload (fields we consume).
function stripeInvoice(overrides: any = {}) {
  return {
    id: 'in_test_1',
    customer: 'cus_ABC',
    subscription: 'sub_XYZ',
    number: 'F00A1B2C-0001',
    status: 'paid',
    amount_due: 54547,
    amount_paid: 54547,
    currency: 'usd',
    period_start: 1780000000,
    period_end: 1782592000,
    hosted_invoice_url: 'https://invoice.stripe.com/i/acct_x/test_abc',
    invoice_pdf: 'https://pay.stripe.com/invoice/acct_x/test_abc/pdf',
    created: 1780000100,
    status_transitions: { paid_at: 1780000200 },
    lines: {
      data: [
        { description: '12 × Usuarios CGuardPro (at $5.15 / month)' },
        { description: 'Procesamiento de pago' },
        { description: 'Implementación (pago único)' },
      ],
    },
    ...overrides,
  };
}

describe('platformBillingService', () => {
  afterEach(() => sinon.restore());

  describe('resolveTenantIdForInvoice', () => {
    it('prefers subscription metadata tenantId', async () => {
      const db = makeFakeDb([{ id: 't-1', planStripeCustomerId: 'cus_ABC' }]);
      const id = await resolveTenantIdForInvoice(
        db,
        stripeInvoice({ subscription_details: { metadata: { tenantId: 't-meta' } } }),
      );
      assert.strictEqual(id, 't-meta');
    });

    it('falls back to planStripeCustomerId lookup', async () => {
      const db = makeFakeDb([{ id: 't-1', planStripeCustomerId: 'cus_ABC' }]);
      const id = await resolveTenantIdForInvoice(db, stripeInvoice());
      assert.strictEqual(id, 't-1');
    });

    it('returns null for unknown customers (webhook must ACK, not retry-loop)', async () => {
      const db = makeFakeDb([]);
      const id = await resolveTenantIdForInvoice(db, stripeInvoice());
      assert.strictEqual(id, null);
    });
  });

  describe('upsertInvoiceFromStripe', () => {
    it('creates a row with mapped fields incl. PDF + hosted links', async () => {
      const db = makeFakeDb([{ id: 't-1', planStripeCustomerId: 'cus_ABC' }]);
      const row = await upsertInvoiceFromStripe(db, stripeInvoice());
      assert.ok(row, 'row created');
      assert.strictEqual(row.tenantId, 't-1');
      assert.strictEqual(row.stripeInvoiceId, 'in_test_1');
      assert.strictEqual(row.number, 'F00A1B2C-0001');
      assert.strictEqual(row.status, 'paid');
      assert.strictEqual(row.amountPaidCents, 54547);
      assert.strictEqual(row.invoicePdfUrl, 'https://pay.stripe.com/invoice/acct_x/test_abc/pdf');
      assert.strictEqual(row.hostedInvoiceUrl, 'https://invoice.stripe.com/i/acct_x/test_abc');
      assert.ok(row.linesSummary.includes('Usuarios CGuardPro'));
      assert.ok(row.paidAt instanceof Date);
    });

    it('is idempotent: same stripeInvoiceId updates in place (no duplicate)', async () => {
      const db = makeFakeDb([{ id: 't-1', planStripeCustomerId: 'cus_ABC' }]);
      await upsertInvoiceFromStripe(db, stripeInvoice({ status: 'open', amount_paid: 0 }));
      await upsertInvoiceFromStripe(db, stripeInvoice({ status: 'paid', amount_paid: 54547 }));
      assert.strictEqual(db._invoices.length, 1, 'single row after re-delivery');
      assert.strictEqual(db._invoices[0].status, 'paid');
      assert.strictEqual(db._invoices[0].amountPaidCents, 54547);
    });

    it('returns null (skips) when no tenant matches', async () => {
      const db = makeFakeDb([]);
      const row = await upsertInvoiceFromStripe(db, stripeInvoice());
      assert.strictEqual(row, null);
      assert.strictEqual(db._invoices.length, 0);
    });
  });

  describe('syncTenantInvoicesFromStripe', () => {
    it('lists from Stripe by customer and upserts each invoice', async () => {
      const tenant = { id: 't-1', planStripeCustomerId: 'cus_ABC' };
      const db = makeFakeDb([tenant]);
      const stripe = {
        invoices: {
          list: sinon.stub().resolves({
            data: [stripeInvoice(), stripeInvoice({ id: 'in_test_2', number: 'F00A1B2C-0002' })],
          }),
        },
      };

      const n = await syncTenantInvoicesFromStripe(db, tenant, stripe);
      assert.strictEqual(n, 2);
      assert.strictEqual(db._invoices.length, 2);
      sinon.assert.calledWithMatch(stripe.invoices.list, { customer: 'cus_ABC' });
    });

    it('no-ops without a stripe customer', async () => {
      const db = makeFakeDb([]);
      const n = await syncTenantInvoicesFromStripe(db, { id: 't-1' }, {});
      assert.strictEqual(n, 0);
    });
  });

  describe('listTenantInvoices', () => {
    it('serializes rows with ISO dates and cents', async () => {
      const db = makeFakeDb([{ id: 't-1', planStripeCustomerId: 'cus_ABC' }]);
      await upsertInvoiceFromStripe(db, stripeInvoice());
      const list = await listTenantInvoices(db, 't-1');
      assert.strictEqual(list.length, 1);
      const inv = list[0];
      assert.strictEqual(inv.stripeInvoiceId, 'in_test_1');
      assert.strictEqual(typeof inv.paidAt, 'string');
      assert.ok(inv.paidAt!.endsWith('Z'));
      assert.strictEqual(inv.amountPaidCents, 54547);
    });

    it('scopes strictly by tenantId', async () => {
      const db = makeFakeDb([
        { id: 't-1', planStripeCustomerId: 'cus_ABC' },
        { id: 't-2', planStripeCustomerId: 'cus_DEF' },
      ]);
      await upsertInvoiceFromStripe(db, stripeInvoice());
      await upsertInvoiceFromStripe(db, stripeInvoice({ id: 'in_other', customer: 'cus_DEF' }));
      const list = await listTenantInvoices(db, 't-2');
      assert.strictEqual(list.length, 1);
      assert.strictEqual(list[0].stripeInvoiceId, 'in_other');
    });
  });
});
