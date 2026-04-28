/**
 * Unit tests: Authentication based on roles
 *
 * Covers:
 *   Suite 1 – Roles class (pure unit, no mocking)
 *   Suite 2 – POST /auth/sign-in handler
 *   Suite 3 – POST /auth/sign-in-customer handler
 *              • role validation (every non-customer role rejected)
 *              • tenant data sanitisation
 *              • asset loading (banners, certs, services)
 *              • clientAccountId resolution (3 fallbacks + healing)
 *              • no-tenant DB path
 *              • AuthService failures
 *
 * Run once: npx cross-env NODE_ENV=test mocha -r ts-node/register
 *           'src/api/auth/auth.roles.test.ts' --exit --timeout 10000
 */

import assert from 'assert';
import sinon  from 'sinon';
import httpMocks from 'node-mocks-http';

import authSignInHandler         from './authSignIn';
import authSignInCustomerHandler from './authSignInCustomer';
import AuthService               from '../../services/auth/authService';
import BannerSuperiorAppService  from '../../services/bannerSuperiorAppService';
import CertificationService      from '../../services/certificationService';
import ServiceService            from '../../services/serviceService';
import Roles                     from '../../security/roles';
import Error400                  from '../../errors/Error400';

// ─── Constants ────────────────────────────────────────────────────────────────

const TENANT_ID  = 'tenant-uuid-test-1234';
const USER_ID    = 'user-uuid-test-5678';
const CLIENT_ID  = 'client-uuid-test-9012';
const TEST_EMAIL = 'customer@example.com';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build the payload that AuthService.signin normally resolves with,
 * using a user that belongs to a tenant with the given role list.
 */
function makeSigninPayload(roles: string[], extraUser: Record<string, any> = {}) {
  return {
    token: 'mock-jwt-token',
    user: {
      id: USER_ID,
      email: TEST_EMAIL,
      firstName: 'Test',
      tenant: {
        tenantId: TENANT_ID,
        tenant: {
          id: TENANT_ID,
          name: 'Test Tenant',
          url:    'http://example.com',  // sensitive – should be stripped
          plan:   'basic',               // sensitive – should be stripped
          logoId: 'logo-uuid-1',         // sensitive – should be stripped
        },
        roles,
        permissions:      [],
        assignedClients:  [],
        assignedPostSites:[],
        status: 'active',
      },
      ...extraUser,
    },
  };
}

/** Payload where the user has NO tenant (e.g. fresh sign-up). */
function makeSigninPayloadNoTenant(extraUser: Record<string, any> = {}) {
  return {
    token: 'mock-jwt-token',
    user: { id: USER_ID, email: TEST_EMAIL, tenant: null, ...extraUser },
  };
}

/** A clientAccount DB record with a sinon-stubbed `.update()` method. */
function makeClientRecord(id = CLIENT_ID, userId: string | null = null) {
  return { id, email: TEST_EMAIL, userId, update: sinon.stub().resolves() };
}

/**
 * Build a minimal mock database object.
 *
 *  clientByUserId   – returned on the 1st  db.clientAccount.findOne call (userId lookup)
 *  tenantUserRecord – returned by db.tenantUser.findOne (assignedClients fallback)
 *  clientByEmail    – returned on the 2nd  db.clientAccount.findOne call (email fallback)
 *  tenantUserRows   – returned by db.tenantUser.findAll (no-tenant verification path)
 */
function makeDb(opts: {
  clientByUserId?:   ReturnType<typeof makeClientRecord> | null;
  tenantUserRecord?: { assignedClients?: { id: string }[] } | null;
  clientByEmail?:    ReturnType<typeof makeClientRecord> | null;
  tenantUserRows?:   Array<{ roles: string | string[] }>;
} = {}) {
  const clientFindOneStub = sinon.stub();
  clientFindOneStub.onFirstCall().resolves(opts.clientByUserId  ?? null);
  clientFindOneStub.onSecondCall().resolves(opts.clientByEmail  ?? null);

  return {
    clientAccount: { findOne: clientFindOneStub },
    tenantUser: {
      findOne: sinon.stub().resolves(opts.tenantUserRecord ?? null),
      findAll: sinon.stub().resolves(opts.tenantUserRows   ?? []),
    },
  };
}

/** Create a mock Express request. `db` maps to `req.database`. */
function makeReq(body: Record<string, any> = {}, db?: ReturnType<typeof makeDb>) {
  const req = httpMocks.createRequest({ method: 'POST', body });
  (req as any).language = 'en';
  if (db !== undefined) (req as any).database = db;
  return req;
}

const makeRes = () => httpMocks.createResponse();

// ══════════════════════════════════════════════════════════════════════════════
// Suite 1 – Roles class
// ══════════════════════════════════════════════════════════════════════════════

describe('Roles', () => {

  describe('values', () => {

    it('contains all expected role keys', () => {
      const expected = [
        'superadmin', 'admin', 'operationsManager', 'securitySupervisor',
        'hrManager', 'clientAccountManager', 'dispatcher',
        'securityGuard', 'customer', 'custom',
      ];
      for (const role of expected) {
        assert.ok(
          Object.prototype.hasOwnProperty.call(Roles.values, role),
          `Expected role "${role}" to exist in Roles.values`,
        );
      }
    });

    it('each role value equals its key (no typos)', () => {
      for (const [key, val] of Object.entries(Roles.values)) {
        assert.strictEqual(val, key, `Roles.values.${key} = "${val}" (expected "${key}")`);
      }
    });

    it('"customer" role is the string "customer"', () => {
      assert.strictEqual(Roles.values.customer, 'customer');
    });

  });

  describe('hierarchy', () => {

    it('superadmin has higher authority than every other role', () => {
      for (const role of Object.keys(Roles.hierarchy)) {
        if (role === 'superadmin') continue;
        assert.ok(
          Roles.hasHigherAuthority('superadmin', role),
          `superadmin should outrank "${role}"`,
        );
      }
    });

    it('admin outranks all non-superadmin operational roles', () => {
      const below = ['operationsManager', 'securityGuard', 'dispatcher', 'customer', 'custom'];
      for (const role of below) {
        assert.ok(Roles.hasHigherAuthority('admin', role), `admin should outrank "${role}"`);
      }
    });

    it('admin does NOT outrank superadmin', () => {
      assert.ok(!Roles.hasHigherAuthority('admin', 'superadmin'));
    });

    it('securityGuard outranks customer', () => {
      assert.ok(Roles.hasHigherAuthority('securityGuard', 'customer'));
    });

    it('customer does NOT outrank securityGuard', () => {
      assert.ok(!Roles.hasHigherAuthority('customer', 'securityGuard'));
    });

    it('hasHigherAuthority returns false for equal roles', () => {
      assert.ok(!Roles.hasHigherAuthority('admin',    'admin'));
      assert.ok(!Roles.hasHigherAuthority('customer', 'customer'));
    });

    it('unknown role does not outrank any known role', () => {
      // Unknown roles default to hierarchy value 0, so they cannot outrank known roles
      assert.ok(!Roles.hasHigherAuthority('unknown', 'admin'));
      assert.ok(!Roles.hasHigherAuthority('unknown', 'customer'));
    });

    it('any known role outranks an unknown role', () => {
      // Known role vs unknown role → the known role wins (unknown defaults to 0)
      assert.ok(Roles.hasHigherAuthority('admin',    'unknown'));
      assert.ok(Roles.hasHigherAuthority('customer', 'unknown'));
    });

  });

});

// ══════════════════════════════════════════════════════════════════════════════
// Suite 2 – POST /auth/sign-in handler
// ══════════════════════════════════════════════════════════════════════════════

describe('POST /auth/sign-in', () => {
  let signinStub: sinon.SinonStub;

  beforeEach(() => { signinStub = sinon.stub(AuthService, 'signin'); });
  afterEach(()  => { sinon.restore(); });

  it('returns 200 with the payload resolved by AuthService', async () => {
    const mockPayload = { token: 'jwt', user: { id: USER_ID, email: TEST_EMAIL } };
    signinStub.resolves(mockPayload);

    const req = makeReq({ email: TEST_EMAIL, password: 'pass' });
    const res = makeRes();
    await authSignInHandler(req, res);

    assert.strictEqual(res._getStatusCode(), 200);
    assert.deepStrictEqual(res._getData(), mockPayload);
  });

  it('passes email, password and invitationToken to AuthService', async () => {
    signinStub.resolves({ token: 'jwt', user: {} });
    const req = makeReq({ email: 'admin@test.com', password: 'secret', invitationToken: 'tok1' });
    const res = makeRes();
    await authSignInHandler(req, res);

    assert.ok(signinStub.calledOnce);
    assert.strictEqual(signinStub.firstCall.args[0], 'admin@test.com');
    assert.strictEqual(signinStub.firstCall.args[1], 'secret');
    assert.strictEqual(signinStub.firstCall.args[2], 'tok1');
  });

  it('returns 400 when AuthService throws Error400 (wrong password)', async () => {
    signinStub.rejects(new Error400('en', 'auth.wrongPassword'));
    const req = makeReq({ email: TEST_EMAIL, password: 'wrong' });
    const res = makeRes();
    await authSignInHandler(req, res);

    assert.strictEqual(res._getStatusCode(), 400);
  });

  it('returns 500 for unexpected errors', async () => {
    signinStub.rejects(new Error('Unexpected DB failure'));
    const req = makeReq({ email: TEST_EMAIL, password: 'pass' });
    const res = makeRes();
    await authSignInHandler(req, res);

    assert.strictEqual(res._getStatusCode(), 500);
  });

});

// ══════════════════════════════════════════════════════════════════════════════
// Suite 3 – POST /auth/sign-in-customer handler
// ══════════════════════════════════════════════════════════════════════════════

describe('POST /auth/sign-in-customer', () => {
  let signinStub:  sinon.SinonStub;
  let bannerStub:  sinon.SinonStub;
  let certStub:    sinon.SinonStub;
  let serviceStub: sinon.SinonStub;

  beforeEach(() => {
    signinStub  = sinon.stub(AuthService, 'signin');
    bannerStub  = sinon.stub(BannerSuperiorAppService.prototype,  'findAndCountAll').resolves({ rows: [], count: 0 });
    certStub    = sinon.stub(CertificationService.prototype,      'findAndCountAll').resolves({ rows: [], count: 0 });
    serviceStub = sinon.stub(ServiceService.prototype,            'findAndCountAll').resolves({ rows: [], count: 0 });
  });

  afterEach(() => { sinon.restore(); });

  // ── Role validation ────────────────────────────────────────────────────────

  describe('role validation', () => {

    it('allows login when tenant role is "customer"', async () => {
      signinStub.resolves(makeSigninPayload([Roles.values.customer]));
      const db  = makeDb({ clientByUserId: makeClientRecord() });
      const req = makeReq({ email: TEST_EMAIL, password: 'pass' }, db);
      const res = makeRes();
      await authSignInCustomerHandler(req, res);

      assert.strictEqual(res._getStatusCode(), 200);
    });

    it('allows login when roles include "customer" alongside others', async () => {
      signinStub.resolves(makeSigninPayload([Roles.values.customer, Roles.values.custom]));
      const db  = makeDb({ clientByUserId: makeClientRecord() });
      const req = makeReq({ email: TEST_EMAIL, password: 'pass' }, db);
      const res = makeRes();
      await authSignInCustomerHandler(req, res);

      assert.strictEqual(res._getStatusCode(), 200);
    });

    // Every non-customer role must be rejected at this endpoint
    const rejectedRoles = [
      Roles.values.superadmin,
      Roles.values.admin,
      Roles.values.operationsManager,
      Roles.values.securitySupervisor,
      Roles.values.hrManager,
      Roles.values.clientAccountManager,
      Roles.values.dispatcher,
      Roles.values.securityGuard,
    ];

    for (const role of rejectedRoles) {
      it(`rejects login when tenant role is "${role}"`, async () => {
        signinStub.resolves(makeSigninPayload([role]));
        const req = makeReq({ email: TEST_EMAIL, password: 'pass' });
        const res = makeRes();
        await authSignInCustomerHandler(req, res);

        assert.strictEqual(res._getStatusCode(), 400, `Expected 400 for role "${role}"`);
      });
    }

    it('rejects login when tenant roles array is empty', async () => {
      signinStub.resolves(makeSigninPayload([]));
      const req = makeReq({ email: TEST_EMAIL, password: 'pass' });
      const res = makeRes();
      await authSignInCustomerHandler(req, res);

      assert.strictEqual(res._getStatusCode(), 400);
    });

  });

  // ── Tenant data sanitisation ───────────────────────────────────────────────

  describe('tenant data sanitisation', () => {

    it('strips url, plan and logoId from the tenant payload', async () => {
      signinStub.resolves(makeSigninPayload([Roles.values.customer]));
      const req = makeReq({ email: TEST_EMAIL, password: 'pass' }, makeDb());
      const res = makeRes();
      await authSignInCustomerHandler(req, res);

      const tenant = res._getData()?.user?.tenant?.tenant;
      assert.ok(tenant,                  'tenant object must exist in response');
      assert.ok(!('url'    in tenant),   'url should be stripped');
      assert.ok(!('plan'   in tenant),   'plan should be stripped');
      assert.ok(!('logoId' in tenant),   'logoId should be stripped');
    });

    it('preserves tenant id and name', async () => {
      signinStub.resolves(makeSigninPayload([Roles.values.customer]));
      const req = makeReq({ email: TEST_EMAIL, password: 'pass' }, makeDb());
      const res = makeRes();
      await authSignInCustomerHandler(req, res);

      const tenant = res._getData()?.user?.tenant?.tenant;
      assert.strictEqual(tenant?.id,   TENANT_ID);
      assert.strictEqual(tenant?.name, 'Test Tenant');
    });

    it('returns correct roles and permissions in the trimmed tenant entry', async () => {
      signinStub.resolves(makeSigninPayload([Roles.values.customer]));
      const req = makeReq({ email: TEST_EMAIL, password: 'pass' }, makeDb());
      const res = makeRes();
      await authSignInCustomerHandler(req, res);

      const tenantEntry = res._getData()?.user?.tenant;
      assert.deepStrictEqual(tenantEntry?.roles, [Roles.values.customer]);
      assert.deepStrictEqual(tenantEntry?.permissions, []);
    });

  });

  // ── Asset loading ──────────────────────────────────────────────────────────

  describe('asset loading', () => {

    it('attaches bannerIds, certificationIds and serviceIds from asset services', async () => {
      bannerStub.resolves({ rows: [{ id: 'b1' }, { id: 'b2' }], count: 2 });
      certStub.resolves({   rows: [{ id: 'c1' }],               count: 1 });
      serviceStub.resolves({ rows: [{ id: 's1' }, { id: 's2' }, { id: 's3' }], count: 3 });

      signinStub.resolves(makeSigninPayload([Roles.values.customer]));
      const req = makeReq({ email: TEST_EMAIL, password: 'pass' }, makeDb());
      const res = makeRes();
      await authSignInCustomerHandler(req, res);

      const tenant = res._getData()?.user?.tenant?.tenant;
      assert.deepStrictEqual(tenant.bannerIds,        ['b1', 'b2']);
      assert.deepStrictEqual(tenant.certificationIds, ['c1']);
      assert.deepStrictEqual(tenant.serviceIds,       ['s1', 's2', 's3']);
    });

    it('falls back to empty arrays when asset services throw', async () => {
      bannerStub.rejects(new Error('DB timeout'));
      certStub.rejects(new Error('DB timeout'));
      serviceStub.rejects(new Error('DB timeout'));

      signinStub.resolves(makeSigninPayload([Roles.values.customer]));
      const req = makeReq({ email: TEST_EMAIL, password: 'pass' }, makeDb());
      const res = makeRes();
      await authSignInCustomerHandler(req, res);

      assert.strictEqual(res._getStatusCode(), 200, 'auth should still succeed');
      const tenant = res._getData()?.user?.tenant?.tenant;
      assert.deepStrictEqual(tenant.bannerIds,        []);
      assert.deepStrictEqual(tenant.certificationIds, []);
      assert.deepStrictEqual(tenant.serviceIds,       []);
    });

  });

  // ── clientAccountId resolution ─────────────────────────────────────────────

  describe('clientAccountId resolution', () => {

    it('sets clientAccountId when the record is found directly by userId', async () => {
      signinStub.resolves(makeSigninPayload([Roles.values.customer]));
      const db  = makeDb({ clientByUserId: makeClientRecord(CLIENT_ID) });
      const req = makeReq({ email: TEST_EMAIL, password: 'pass' }, db);
      const res = makeRes();
      await authSignInCustomerHandler(req, res);

      assert.strictEqual(res._getData()?.user?.clientAccountId, CLIENT_ID);
    });

    it('sets clientAccountId via tenantUser.assignedClients (fallback 1) when userId lookup fails', async () => {
      signinStub.resolves(makeSigninPayload([Roles.values.customer]));
      const db = makeDb({
        clientByUserId:  null,
        tenantUserRecord: { assignedClients: [{ id: CLIENT_ID }] },
      });
      const req = makeReq({ email: TEST_EMAIL, password: 'pass' }, db);
      const res = makeRes();
      await authSignInCustomerHandler(req, res);

      assert.strictEqual(res._getData()?.user?.clientAccountId, CLIENT_ID);
    });

    it('sets clientAccountId via email match (fallback 2) when both prior lookups fail', async () => {
      signinStub.resolves(makeSigninPayload([Roles.values.customer]));
      const emailRecord = makeClientRecord(CLIENT_ID);
      const db = makeDb({
        clientByUserId:  null,
        tenantUserRecord: null,
        clientByEmail:   emailRecord,
      });
      const req = makeReq({ email: TEST_EMAIL, password: 'pass' }, db);
      const res = makeRes();
      await authSignInCustomerHandler(req, res);

      assert.strictEqual(res._getData()?.user?.clientAccountId, CLIENT_ID);
    });

    it('heals clientAccount.userId when the email fallback is used', async () => {
      signinStub.resolves(makeSigninPayload([Roles.values.customer]));
      const emailRecord = makeClientRecord(CLIENT_ID);
      const db = makeDb({
        clientByUserId:  null,
        tenantUserRecord: null,
        clientByEmail:   emailRecord,
      });
      const req = makeReq({ email: TEST_EMAIL, password: 'pass' }, db);
      const res = makeRes();
      await authSignInCustomerHandler(req, res);

      assert.ok(emailRecord.update.calledOnce, 'update() should be called once');
      assert.deepStrictEqual(
        emailRecord.update.firstCall.args[0],
        { userId: USER_ID },
        'update should set userId to the logged-in user',
      );
    });

    it('returns 200 without clientAccountId when no client record exists anywhere', async () => {
      signinStub.resolves(makeSigninPayload([Roles.values.customer]));
      const db = makeDb({ clientByUserId: null, tenantUserRecord: null, clientByEmail: null });
      const req = makeReq({ email: TEST_EMAIL, password: 'pass' }, db);
      const res = makeRes();
      await authSignInCustomerHandler(req, res);

      assert.strictEqual(res._getStatusCode(), 200, 'auth should still succeed');
      const clientId = res._getData()?.user?.clientAccountId;
      assert.ok(clientId === undefined || clientId === null, 'clientAccountId should be absent');
    });

    it('returns 200 gracefully when req.database is unavailable', async () => {
      signinStub.resolves(makeSigninPayload([Roles.values.customer]));
      const req = makeReq({ email: TEST_EMAIL, password: 'pass' }); // no DB passed
      const res = makeRes();
      await authSignInCustomerHandler(req, res);

      assert.strictEqual(res._getStatusCode(), 200);
    });

  });

  // ── No-tenant fallback path (DB verification) ──────────────────────────────

  describe('no-tenant fallback path', () => {

    it('allows login when user has no tenant but DB confirms customer role', async () => {
      signinStub.resolves(makeSigninPayloadNoTenant());
      const db = makeDb({
        tenantUserRows: [{ roles: JSON.stringify([Roles.values.customer]) }],
      });
      const req = makeReq({ email: TEST_EMAIL, password: 'pass' }, db);
      const res = makeRes();
      await authSignInCustomerHandler(req, res);

      assert.strictEqual(res._getStatusCode(), 200);
    });

    it('allows login when customer role is stored as a plain array (not JSON string)', async () => {
      signinStub.resolves(makeSigninPayloadNoTenant());
      const db = makeDb({
        tenantUserRows: [{ roles: [Roles.values.customer] }],
      });
      const req = makeReq({ email: TEST_EMAIL, password: 'pass' }, db);
      const res = makeRes();
      await authSignInCustomerHandler(req, res);

      assert.strictEqual(res._getStatusCode(), 200);
    });

    it('rejects login when user has no tenant and DB only shows admin role', async () => {
      signinStub.resolves(makeSigninPayloadNoTenant());
      const db = makeDb({
        tenantUserRows: [{ roles: JSON.stringify([Roles.values.admin]) }],
      });
      const req = makeReq({ email: TEST_EMAIL, password: 'pass' }, db);
      const res = makeRes();
      await authSignInCustomerHandler(req, res);

      assert.strictEqual(res._getStatusCode(), 400);
    });

    it('rejects login when user has no tenant and no tenantUser rows exist', async () => {
      signinStub.resolves(makeSigninPayloadNoTenant());
      const db  = makeDb({ tenantUserRows: [] });
      const req = makeReq({ email: TEST_EMAIL, password: 'pass' }, db);
      const res = makeRes();
      await authSignInCustomerHandler(req, res);

      assert.strictEqual(res._getStatusCode(), 400);
    });

  });

  // ── AuthService failures ───────────────────────────────────────────────────

  describe('AuthService.signin failures', () => {

    it('returns 400 when AuthService rejects with Error400 (wrong credentials)', async () => {
      signinStub.rejects(new Error400('en', 'auth.wrongPassword'));
      const req = makeReq({ email: TEST_EMAIL, password: 'wrong' });
      const res = makeRes();
      await authSignInCustomerHandler(req, res);

      assert.strictEqual(res._getStatusCode(), 400);
    });

    it('returns 400 when AuthService rejects with email-not-verified error', async () => {
      signinStub.rejects(new Error400('en', 'auth.emailNotVerified'));
      const req = makeReq({ email: TEST_EMAIL, password: 'pass' });
      const res = makeRes();
      await authSignInCustomerHandler(req, res);

      assert.strictEqual(res._getStatusCode(), 400);
    });

    it('returns 500 for unexpected errors from AuthService', async () => {
      signinStub.rejects(new Error('Unexpected DB failure'));
      const req = makeReq({ email: TEST_EMAIL, password: 'pass' });
      const res = makeRes();
      await authSignInCustomerHandler(req, res);

      assert.strictEqual(res._getStatusCode(), 500);
    });

  });

});
