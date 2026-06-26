/**
 * Unit tests — financial-validation-utils domain.
 *
 * Pure + lightly-mocked tests for the deterministic money/validation logic that
 * powers Programador cost estimates, invoice payments and Sequelize filtering.
 * No MySQL, no network: `computeShiftsCost` / `SequelizeFilterUtils.uuid` are
 * pure; `getCostSettings` runs against an in-memory fake `db`; the PaymentService
 * over-total guard runs the REAL `create()` with the static repository methods
 * stubbed via sinon.
 *
 * Mirrors the style of src/services/communication/__tests__/routing.test.ts
 * (node `assert` + sinon, fake db rows, no DB).
 *
 * Run:
 *   cross-env NODE_ENV=test TS_NODE_PROJECT=tsconfig.test.json \
 *     npx mocha -r ts-node/register \
 *     'tests/unit/financial-validation-utils/financial.test.ts' --exit --timeout 20000
 */

import assert from 'assert';
import sinon from 'sinon';
import Sequelize from 'sequelize';

import {
  computeShiftsCost,
  getCostSettings,
  CostSettings,
  ShiftForCost,
} from '../../../src/services/scheduleCostService';
import SequelizeFilterUtils from '../../../src/database/utils/sequelizeFilterUtils';

// A complete CostSettings with sane Ecuador-ish defaults; tests override fields.
function settings(overrides: Partial<CostSettings> = {}): CostSettings {
  return {
    currency: 'USD',
    defaultHourlyRate: 10,
    overtimeThresholdHours: 8,
    overtimeMultiplier: 1.5,
    nightSurchargePct: 0,
    nightStartHour: 19,
    nightEndHour: 6,
    guardRates: {},
    ...overrides,
  };
}

// Helper to build a UTC shift of `hours` length starting at a UTC ISO instant.
function shift(startIso: string, hours: number, guardId?: string): ShiftForCost {
  const start = new Date(startIso);
  const end = new Date(start.getTime() + hours * 3_600_000);
  return { guardId: guardId ?? null, startTime: start, endTime: end };
}

// ───────────────────────── computeShiftsCost (pure) ─────────────────────────

describe('scheduleCostService.computeShiftsCost', () => {
  it('costs a plain 8h day shift at the default rate, no overtime, no night', () => {
    // 09:00 UTC start → daytime; 8h exactly = threshold, so zero overtime.
    const r = computeShiftsCost([shift('2026-06-24T09:00:00Z', 8)], settings(), 'UTC');
    assert.strictEqual(r.hasRate, true);
    assert.strictEqual(r.regularHours, 8);
    assert.strictEqual(r.overtimeHours, 0);
    assert.strictEqual(r.nightHours, 0);
    assert.strictEqual(r.totalCost, 80); // 8 * 10
    assert.strictEqual(r.shiftCount, 1);
    assert.strictEqual(r.currency, 'USD');
  });

  it('splits regular vs overtime at the threshold and applies the OT multiplier', () => {
    // 12h day shift: 8 regular @10 = 80, 4 OT @10*1.5 = 60 → 140.
    const r = computeShiftsCost([shift('2026-06-24T09:00:00Z', 12)], settings(), 'UTC');
    assert.strictEqual(r.regularHours, 8);
    assert.strictEqual(r.overtimeHours, 4);
    assert.strictEqual(r.totalCost, 140);
  });

  it('adds the night surcharge for a shift that starts inside the night window', () => {
    // Start 20:00 UTC (>= nightStart 19) → night. 8h, surcharge 25%.
    // base 8*10=80, OT 0, night add = 8h * 10 * 0.25 = 20 → 100.
    const r = computeShiftsCost(
      [shift('2026-06-24T20:00:00Z', 8)],
      settings({ nightSurchargePct: 0.25 }),
      'UTC',
    );
    assert.strictEqual(r.nightHours, 8);
    assert.strictEqual(r.totalCost, 100);
  });

  it('treats a post-midnight start (before nightEndHour) as night too', () => {
    // 02:00 UTC start (< nightEnd 6) → night window.
    const r = computeShiftsCost(
      [shift('2026-06-24T02:00:00Z', 6)],
      settings({ nightSurchargePct: 0.25 }),
      'UTC',
    );
    assert.strictEqual(r.nightHours, 6);
    // 6 reg *10 = 60, night add 6*10*0.25 = 15 → 75
    assert.strictEqual(r.totalCost, 75);
  });

  it('does NOT flag a daytime shift as night', () => {
    const r = computeShiftsCost(
      [shift('2026-06-24T10:00:00Z', 8)],
      settings({ nightSurchargePct: 0.25 }),
      'UTC',
    );
    assert.strictEqual(r.nightHours, 0);
    assert.strictEqual(r.totalCost, 80); // no surcharge
  });

  it('uses a per-guard rate override when present, default otherwise', () => {
    const s = settings({ defaultHourlyRate: 10, guardRates: { g1: 20 } });
    // g1: 8h * 20 = 160; g2 (no override): 8h * 10 = 80 → 240.
    const r = computeShiftsCost(
      [shift('2026-06-24T09:00:00Z', 8, 'g1'), shift('2026-06-24T09:00:00Z', 8, 'g2')],
      s,
      'UTC',
    );
    assert.strictEqual(r.totalCost, 240);
    assert.strictEqual(r.regularHours, 16);
    assert.strictEqual(r.shiftCount, 2);
  });

  it('reports hasRate=false (hours only) when no rate is configured', () => {
    const s = settings({ defaultHourlyRate: 0, guardRates: {} });
    const r = computeShiftsCost([shift('2026-06-24T09:00:00Z', 8)], s, 'UTC');
    assert.strictEqual(r.hasRate, false);
    assert.strictEqual(r.totalCost, 0); // rate is 0 → no dollars
    assert.strictEqual(r.regularHours, 8); // hours still counted
  });

  it('reports hasRate=true when ONLY a per-guard rate exists (no default)', () => {
    const s = settings({ defaultHourlyRate: 0, guardRates: { g1: 12 } });
    const r = computeShiftsCost([shift('2026-06-24T09:00:00Z', 8, 'g1')], s, 'UTC');
    assert.strictEqual(r.hasRate, true);
    assert.strictEqual(r.totalCost, 96); // 8 * 12
  });

  it('skips zero-length and negative-duration shifts (end <= start)', () => {
    const zero = { guardId: null, startTime: new Date('2026-06-24T09:00:00Z'), endTime: new Date('2026-06-24T09:00:00Z') };
    const neg = { guardId: null, startTime: new Date('2026-06-24T12:00:00Z'), endTime: new Date('2026-06-24T09:00:00Z') };
    const r = computeShiftsCost([zero, neg], settings(), 'UTC');
    assert.strictEqual(r.regularHours, 0);
    assert.strictEqual(r.overtimeHours, 0);
    assert.strictEqual(r.totalCost, 0);
    // shiftCount counts the INPUT array length (both rows), even when skipped.
    assert.strictEqual(r.shiftCount, 2);
  });

  it('accepts ISO-string start/end (not just Date objects)', () => {
    const r = computeShiftsCost(
      [{ guardId: null, startTime: '2026-06-24T09:00:00Z', endTime: '2026-06-24T17:00:00Z' }],
      settings(),
      'UTC',
    );
    assert.strictEqual(r.regularHours, 8);
    assert.strictEqual(r.totalCost, 80);
  });

  it('aggregates and rounds totals across many shifts (2-decimal cost, 1-decimal hours)', () => {
    // Three 8.5h day shifts: per shift 8 reg @10 = 80, 0.5 OT @15 = 7.5 → 87.5.
    // x3 = 262.5 cost; regular 24, OT 1.5.
    const shifts = [
      shift('2026-06-24T09:00:00Z', 8.5),
      shift('2026-06-25T09:00:00Z', 8.5),
      shift('2026-06-26T09:00:00Z', 8.5),
    ];
    const r = computeShiftsCost(shifts, settings(), 'UTC');
    assert.strictEqual(r.totalCost, 262.5);
    assert.strictEqual(r.regularHours, 24);
    assert.strictEqual(r.overtimeHours, 1.5);
  });

  it('respects the tenant timezone when deciding night (UTC instant, local hour)', () => {
    // 2026-06-24T03:00:00Z. In America/Guayaquil (UTC-5) that is 22:00 local →
    // night. With a 25% surcharge over a 4h shift: 4*10 + 4*10*0.25 = 50.
    const r = computeShiftsCost(
      [shift('2026-06-24T03:00:00Z', 4)],
      settings({ nightSurchargePct: 0.25 }),
      'America/Guayaquil',
    );
    assert.strictEqual(r.nightHours, 4);
    assert.strictEqual(r.totalCost, 50);
    // Same instant in UTC is 03:00 → also night (< 6), but verify the local-hour
    // path didn't silently fall back to UTC by using a tz where it's daytime:
    const day = computeShiftsCost(
      [shift('2026-06-24T17:00:00Z', 4)], // 12:00 local in Guayaquil → day
      settings({ nightSurchargePct: 0.25 }),
      'America/Guayaquil',
    );
    assert.strictEqual(day.nightHours, 0);
    assert.strictEqual(day.totalCost, 40);
  });

  it('returns an empty/zero result for no shifts', () => {
    const r = computeShiftsCost([], settings(), 'UTC');
    assert.strictEqual(r.totalCost, 0);
    assert.strictEqual(r.shiftCount, 0);
    assert.strictEqual(r.regularHours, 0);
  });
});

// ───────────────────────── getCostSettings (fake db) ─────────────────────────

describe('scheduleCostService.getCostSettings', () => {
  function dbWith(nominaSettings: any) {
    return {
      settings: {
        async findByPk(_id: string) {
          return nominaSettings === undefined ? null : { id: _id, nominaSettings };
        },
      },
    };
  }

  it('returns the documented defaults when the tenant has no payroll config', async () => {
    const cs = await getCostSettings(dbWith(undefined), 'tenant-A');
    assert.strictEqual(cs.currency, 'USD');
    assert.strictEqual(cs.defaultHourlyRate, 0);
    assert.strictEqual(cs.overtimeThresholdHours, 8);
    assert.strictEqual(cs.overtimeMultiplier, 1.5);
    assert.strictEqual(cs.nightStartHour, 19);
    assert.strictEqual(cs.nightEndHour, 6);
    assert.deepStrictEqual(cs.guardRates, {});
  });

  it('reads tenant payroll overrides and coerces numeric strings', async () => {
    const cs = await getCostSettings(
      dbWith({
        payroll: {
          currency: 'PEN',
          defaultHourlyRate: '15',
          overtimeThresholdHours: '6',
          overtimeMultiplier: '2',
          nightSurchargePct: '0.25',
          nightStartHour: '20',
          nightEndHour: '5',
          guardRates: { g1: 30 },
        },
      }),
      'tenant-A',
    );
    assert.strictEqual(cs.currency, 'PEN');
    assert.strictEqual(cs.defaultHourlyRate, 15);
    assert.strictEqual(cs.overtimeThresholdHours, 6);
    assert.strictEqual(cs.overtimeMultiplier, 2);
    assert.strictEqual(cs.nightSurchargePct, 0.25);
    assert.strictEqual(cs.nightStartHour, 20);
    assert.strictEqual(cs.nightEndHour, 5);
    assert.deepStrictEqual(cs.guardRates, { g1: 30 });
  });

  it('falls back to threshold/multiplier defaults for zero/NaN values', async () => {
    // overtimeThresholdHours 0 is falsy → defaults to 8; multiplier 0 → 1.5.
    const cs = await getCostSettings(
      dbWith({ payroll: { overtimeThresholdHours: 0, overtimeMultiplier: 0 } }),
      'tenant-A',
    );
    assert.strictEqual(cs.overtimeThresholdHours, 8);
    assert.strictEqual(cs.overtimeMultiplier, 1.5);
  });

  it('end-to-end: settings → cost is consistent with what the CRM displays', async () => {
    // The Programador summary card (Schedule.tsx) reads {currency, hasRate,
    // projected, delta} straight off the backend computeShiftsCost output — it
    // does NOT recompute. This asserts the producer side stays self-consistent.
    const cs = await getCostSettings(
      dbWith({ payroll: { currency: 'USD', defaultHourlyRate: 10 } }),
      'tenant-A',
    );
    const r = computeShiftsCost([shift('2026-06-24T09:00:00Z', 8)], cs, 'UTC');
    assert.strictEqual(r.currency, cs.currency);
    assert.strictEqual(r.hasRate, true);
    assert.strictEqual(r.totalCost, 80);
  });
});

// ──────────────────────── SequelizeFilterUtils.uuid (pure) ────────────────────────

describe('SequelizeFilterUtils.uuid', () => {
  it('passes a valid UUID through unchanged', () => {
    const valid = '123e4567-e89b-42d3-a456-426614174000';
    assert.strictEqual(SequelizeFilterUtils.uuid(valid), valid);
  });

  it('replaces an invalid UUID with a fresh (non-matching) UUID', () => {
    const out = SequelizeFilterUtils.uuid('not-a-uuid');
    assert.notStrictEqual(out, 'not-a-uuid');
    // Output is itself a valid v4-shaped UUID (8-4-4-4-12 hex).
    assert.match(out, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });

  it('produces a different replacement each call (no collisions for empty input)', () => {
    const a = SequelizeFilterUtils.uuid('');
    const b = SequelizeFilterUtils.uuid('');
    assert.notStrictEqual(a, b);
  });

  it('ilikeIncludes builds a lowercased %wrapped% LIKE condition', () => {
    // We only assert the function runs and returns a Sequelize where-fragment
    // object (it must not throw and must reference the column/value).
    const cond: any = SequelizeFilterUtils.ilikeIncludes('invoice', 'invoiceNumber', 'INV-100');
    assert.ok(cond, 'should return a where fragment');
    // The operator payload lives under the Sequelize.Op.like SYMBOL key (not a
    // string key, so JSON.stringify won't see it). The value is lowercased and
    // %-wrapped.
    const likeVal = cond.logic[(Sequelize as any).Op.like];
    assert.strictEqual(likeVal, '%inv-100%', 'value should be lowercased + %-wrapped');
  });
});

// ─────────────────── PaymentService over-total guard (stubbed repos) ───────────────────

describe('PaymentService.create — over-total guard', () => {
  let PaymentService: any;
  let InvoiceRepository: any;
  let SequelizeRepository: any;

  beforeEach(() => {
    // Require lazily so the sinon stubs land on the same module instances the
    // service closes over.
    PaymentService = require('../../../src/services/paymentService').default;
    InvoiceRepository = require('../../../src/database/repositories/invoiceRepository').default;
    SequelizeRepository = require('../../../src/database/repositories/sequelizeRepository').default;

    sinon.stub(SequelizeRepository, 'createTransaction').resolves({ LOCK: { UPDATE: 'UPDATE' } } as any);
    sinon.stub(SequelizeRepository, 'commitTransaction').resolves();
    sinon.stub(SequelizeRepository, 'rollbackTransaction').resolves();
    sinon.stub(SequelizeRepository, 'getCurrentUser').returns({ id: 'user-1' } as any);
    sinon.stub(SequelizeRepository, 'getCurrentTenant').returns({ id: 'tenant-A' } as any);
  });

  afterEach(() => sinon.restore());

  /** Build service options whose db.invoice.findOne returns the locked invoice. */
  function svc(invoice: any) {
    const updateSpy = sinon.stub(InvoiceRepository, 'update').resolves(invoice);
    sinon.stub(InvoiceRepository, 'findById').resolves(invoice);
    const options = {
      database: {
        invoice: {
          async findOne() {
            return invoice;
          },
        },
      },
    };
    return { service: new PaymentService(options), updateSpy };
  }

  it('rejects a payment that would push total payments over the invoice total', async () => {
    // Invoice total 100, already paid 80; a 30 payment → 110 > 100 → blocked.
    const invoice = { id: 'inv-1', total: 100, payments: [{ amount: 80 }] };
    const { service, updateSpy } = svc(invoice);

    await assert.rejects(
      () => service.create({ invoiceId: 'inv-1', amount: 30 }),
      (err: any) => {
        assert.strictEqual(err.code, 400);
        assert.match(err.message, /no puede exceder el total/i);
        return true;
      },
    );
    assert.ok(updateSpy.notCalled, 'invoice must NOT be updated on an over-total payment');
  });

  it('allows a payment that exactly reaches the invoice total', async () => {
    const invoice = { id: 'inv-1', total: 100, payments: [{ amount: 80 }] };
    const { service, updateSpy } = svc(invoice);

    const payment = await service.create({ invoiceId: 'inv-1', amount: 20 });
    assert.strictEqual(payment.amount, 20);
    assert.ok(updateSpy.calledOnce, 'a within-total payment is persisted');
    // The new payment is prepended to the existing array.
    const persisted = updateSpy.firstCall.args[1].payments;
    assert.strictEqual(persisted.length, 2);
    assert.strictEqual(persisted[0].amount, 20);
  });

  it('tolerates a sub-cent rounding epsilon (proposedSum within 0.005)', async () => {
    // total 100, paid 99.999 → 0.004 over after +0.0? Use paid 100, add 0.004.
    const invoice = { id: 'inv-1', total: 100, payments: [{ amount: 100 }] };
    const { service } = svc(invoice);
    // 100 + 0.004 = 100.004 ≤ 100 + 0.005 → allowed.
    const payment = await service.create({ invoiceId: 'inv-1', amount: 0.004 });
    assert.strictEqual(payment.amount, 0.004);
  });

  it('sums prior payments across the {amount|total|paid} shapes when checking the cap', async () => {
    // Existing rows use mixed keys; the guard must sum all of them: 50+30+15 = 95.
    // Adding 10 → 105 > 100 → blocked.
    const invoice = {
      id: 'inv-1',
      total: 100,
      payments: [{ amount: 50 }, { total: 30 }, { paid: 15 }],
    };
    const { service } = svc(invoice);
    await assert.rejects(() => service.create({ invoiceId: 'inv-1', amount: 10 }), /no puede exceder/i);
  });

  it('requires an invoiceId', async () => {
    const { service } = svc({ id: 'x', total: 100, payments: [] });
    await assert.rejects(
      () => service.create({ amount: 10 }),
      (err: any) => err.code === 400 && /invoiceId is required/.test(err.message),
    );
  });
});
