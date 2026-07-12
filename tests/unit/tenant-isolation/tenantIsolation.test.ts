/**
 * Unit tests — TENANT ISOLATION regression suite.
 *
 * The platform's cross-tenant safety net: a single forgotten `tenantId` filter
 * or a coerced `:tenantId` in the URL is a silent cross-tenant breach. These
 * tests exercise the REAL isolation choke points against fake req objects so a
 * regression here fails CI instead of leaking a customer's data.
 *
 *  - tenantMiddleware: an authenticated user coercing :tenantId to a tenant they
 *    don't belong to must get 403; a member passes; a superadmin is exempt.
 *  - isUserInTenant: the membership predicate the guard relies on.
 *  - isSuperadminUser: the exemption predicate (must not over-grant).
 *  - Repository where-clauses: representative tenant-scoped queries must always
 *    carry a tenantId in their filter (catches an accidentally-dropped scope).
 *
 * No MySQL, no network — mirrors tests/unit/financial-validation-utils style.
 *
 * Run:
 *   cross-env NODE_ENV=test TS_NODE_PROJECT=tsconfig.test.json \
 *     npx mocha -r ts-node/register \
 *     'tests/unit/tenant-isolation/tenantIsolation.test.ts' --exit --timeout 20000
 */

import assert from 'assert';
import sinon from 'sinon';

import { isUserInTenant } from '../../../src/database/utils/userTenantUtils';
import { isSuperadminUser } from '../../../src/middlewares/superadminMiddleware';

// tenantMiddleware pulls TenantService.findById + paywall; stub those so we test
// ONLY the isolation guard.
import * as tenantServiceModule from '../../../src/services/tenantService';
import * as paywallModule from '../../../src/middlewares/paywall';
import { tenantMiddleware } from '../../../src/middlewares/tenantMiddleware';

const TENANT_A = 'aaaaaaaa-0000-0000-0000-000000000001';
const TENANT_B = 'bbbbbbbb-0000-0000-0000-000000000002';

/**
 * Deep-scan a Sequelize where object for a `tenantId: <id>` scope. Walks arrays
 * and objects including SYMBOL keys ([Op.and]/[Op.eq]) — which JSON.stringify
 * drops — so a tenant filter nested under [Op.and] is still detected.
 */
function whereHasTenant(node: any, tenantId: string, depth = 0): boolean {
  if (node == null || depth > 8) return false;
  if (Array.isArray(node)) return node.some((n) => whereHasTenant(n, tenantId, depth + 1));
  if (typeof node === 'object') {
    for (const key of Reflect.ownKeys(node)) {
      const val = (node as any)[key];
      if (key === 'tenantId') {
        if (val === tenantId) return true;
        if (val && typeof val === 'object') {
          // { tenantId: { [Op.eq]: tenantId } }
          for (const k of Reflect.ownKeys(val)) if ((val as any)[k] === tenantId) return true;
        }
      }
      if (whereHasTenant(val, tenantId, depth + 1)) return true;
    }
  }
  return false;
}

function member(tenantId: string) {
  return { id: 'user-1', tenants: [{ tenant: { id: tenantId }, status: 'active', roles: ['admin'] }] };
}

/** Drive the real tenantMiddleware with a fake req for :tenantId=`value`. */
async function runGuard(currentUser: any, value: string): Promise<{ status: number | null; passed: boolean }> {
  const findByIdStub = sinon
    .stub(tenantServiceModule.default.prototype, 'findById')
    .resolves({ id: value } as any);
  // Never let the paywall interfere with the isolation assertion.
  const paywallStub = sinon.stub(paywallModule, 'enforcePaywall').returns(false);

  let passed = false;
  let errStatus: number | null = null;
  const req: any = { currentUser, language: 'en', params: { tenantId: value } };
  const res: any = {};
  const next = (err?: any) => {
    if (err) errStatus = err.code || err.status || 403;
    else passed = true;
  };

  try {
    await tenantMiddleware(req, res, next, value, 'tenantId');
  } finally {
    findByIdStub.restore();
    paywallStub.restore();
  }
  return { status: errStatus, passed };
}

describe('tenant isolation', () => {
  afterEach(() => sinon.restore());

  describe('isUserInTenant (membership predicate)', () => {
    it('true when the user has a membership for the tenant', () => {
      assert.strictEqual(isUserInTenant(member(TENANT_A), { id: TENANT_A }), true);
    });
    it('FALSE when the user has no membership for the tenant (the breach case)', () => {
      assert.strictEqual(isUserInTenant(member(TENANT_A), { id: TENANT_B }), false);
    });
    it('false for a null user', () => {
      assert.strictEqual(isUserInTenant(null, { id: TENANT_A }), false);
    });
  });

  describe('isSuperadminUser (exemption predicate — must not over-grant)', () => {
    it('true for isSuperadmin flag', () => {
      assert.strictEqual(isSuperadminUser({ isSuperadmin: true }), true);
    });
    it('true for a superadmin role', () => {
      assert.strictEqual(isSuperadminUser({ roles: ['superadmin'] }), true);
    });
    it('FALSE for an ordinary tenant admin (a normal admin is NOT platform superadmin)', () => {
      assert.strictEqual(isSuperadminUser(member(TENANT_A)), false);
    });
    it('false for null', () => {
      assert.strictEqual(isSuperadminUser(null), false);
    });
  });

  describe('tenantMiddleware isolation guard', () => {
    it('BLOCKS a member of tenant A from coercing :tenantId to tenant B', async () => {
      const r = await runGuard(member(TENANT_A), TENANT_B);
      assert.strictEqual(r.passed, false, 'must NOT pass through to the handler');
      assert.strictEqual(r.status, 403, 'must be a 403 Forbidden');
    });

    it('ALLOWS a member accessing their own tenant', async () => {
      const r = await runGuard(member(TENANT_A), TENANT_A);
      assert.strictEqual(r.passed, true);
      assert.strictEqual(r.status, null);
    });

    it('EXEMPTS a platform superadmin (manages across tenants)', async () => {
      const r = await runGuard({ isSuperadmin: true, tenants: [] }, TENANT_B);
      assert.strictEqual(r.passed, true);
    });

    it('does not break lean/anonymous requests (no loaded memberships)', async () => {
      // currentUser without a tenants array → handler-level auth still applies,
      // the central guard intentionally stays out of the way.
      const r = await runGuard({ id: 'lean' }, TENANT_B);
      assert.strictEqual(r.passed, true);
    });
  });

  describe('repository where-clauses carry a tenant scope', () => {
    // A structural guard: representative tenant-scoped list queries must include
    // tenantId in their where clause. Catches an accidentally-dropped filter.
    it('guardShift list query filters by tenantId', async () => {
      const GuardShiftRepository = require('../../../src/database/repositories/guardShiftRepository').default;
      const captured: any[] = [];
      const db: any = {
        guardShift: {
          findAndCountAll: async (opts: any) => { captured.push(opts); return { rows: [], count: 0 }; },
          findAll: async (opts: any) => { captured.push(opts); return []; },
        },
        Sequelize: require('sequelize'),
      };
      const options: any = { database: db, currentTenant: { id: TENANT_A } };
      try {
        await GuardShiftRepository.findAndCountAll({ filter: {} }, options);
      } catch {
        /* the repo may need more of the fake db; we only assert on captured opts */
      }
      assert.ok(captured.length, 'expected the repository to run a guardShift query');
      // Sequelize combines clauses under [Op.and] / [Op.eq] — Symbol keys that
      // JSON.stringify silently drops. Deep-scan own AND symbol keys instead.
      const scoped = whereHasTenant(captured[0].where, TENANT_A);
      assert.ok(scoped, 'guardShift list where-clause must be tenant-scoped');
    });
  });
});
