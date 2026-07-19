/**
 * Unit tests — account-status login gate (deactivated tenant membership).
 *
 * Closes the audit gap: a tenantUser whose per-tenant `status` was deactivated
 * by an admin (slug 'archived' — set by userSuspend / userBulkSuspend /
 * guard-archive; the model's isIn is ['active','invited','pending','archived'])
 * must NOT be able to mint a session on ANY channel. The channel↔role gate does
 * NOT catch this: archiving keeps the member's role(s), so an 'archived' guard
 * still passes the 'worker' channel check and would otherwise obtain a worker
 * token. The gate lives in AuthService.signin (the single choke point where the
 * SELECTED membership is known, before the JWT is signed) so it covers
 * web / worker / supervisor in one spot.
 *
 * Approach mirrors tests/unit/attendance/attendance.test.ts and
 * tests/unit/auth/authChannelGate.test.ts: NO real DB / network. The repository
 * statics and bcrypt that signin calls to reach the gate are sinon-stubbed; the
 * REAL AuthService.signin (with the REAL gate) runs against the fakes.
 *
 * Run: npm run test:unit
 */

import assert from 'assert';
import sinon from 'sinon';

import AuthService from '../../../src/services/auth/authService';
import UserRepository from '../../../src/database/repositories/userRepository';
import SequelizeRepository from '../../../src/database/repositories/sequelizeRepository';
import RoleRepository from '../../../src/database/repositories/roleRepository';

// bcryptjs is a singleton module; stub the same object authService references.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const bcrypt = require('bcryptjs');

const EMAIL = 'guard@example.com';
const USER_ID = 'user-acct-status-1';
const TENANT_ID = 'tenant-acct-status-1';

// ── Fake Sequelize-ish db: only the `user` model methods signin/mintSession use.
function makeDb() {
  return {
    user: {
      // lockState read (findByPk(...).catch) AND mintSessionClaims read.
      findByPk: async () => null,
      update: async () => [1],
    },
  } as any;
}

/** The shape UserRepository.findById resolves to during signin, carrying ONE
 *  tenant membership with the given status + roles. */
function makeFullUser(status: string, roles: string[]) {
  return {
    id: USER_ID,
    email: EMAIL,
    firstName: 'Test',
    lastName: 'Guard',
    emailVerified: true,
    isSuperadmin: false,
    tenants: [
      {
        id: 'tu-1',
        tenantId: TENANT_ID,
        tenant: { id: TENANT_ID, name: 'Acme Security' }, // no suspendedAt
        roles,
        permissions: [],
        permissionOverrides: { grant: [], deny: [] },
        assignedClients: [],
        assignedPostSites: [],
        status,
      },
    ],
  };
}

/** Drive the REAL AuthService.signin for the given membership status + channel. */
async function runSignin(status: string, app: string, roles: string[] = ['securityGuard']) {
  sinon.stub(UserRepository, 'findById').resolves(makeFullUser(status, roles) as any);
  const options: any = { database: makeDb(), language: 'en', body: { app } };
  return AuthService.signin(EMAIL, 'Passw0rd!', undefined, undefined, options);
}

describe('auth · account-status login gate', () => {
  let envSecret: string | undefined;
  let envExpires: string | undefined;

  before(() => {
    // jwt.sign (active path) needs a secret + a valid expiresIn; capture + set.
    envSecret = process.env.AUTH_JWT_SECRET;
    envExpires = process.env.AUTH_JWT_EXPIRES_IN;
    process.env.AUTH_JWT_SECRET = 'test-secret-account-status-gate-000000';
    process.env.AUTH_JWT_EXPIRES_IN = '1d';
  });

  after(() => {
    if (envSecret === undefined) delete process.env.AUTH_JWT_SECRET;
    else process.env.AUTH_JWT_SECRET = envSecret;
    if (envExpires === undefined) delete process.env.AUTH_JWT_EXPIRES_IN;
    else process.env.AUTH_JWT_EXPIRES_IN = envExpires;
  });

  beforeEach(() => {
    // Everything signin calls BEFORE the gate → stubbed to the happy path so the
    // ONLY variable under test is the membership status.
    sinon.stub(SequelizeRepository, 'createTransaction').resolves({} as any);
    sinon.stub(SequelizeRepository, 'commitTransaction').resolves();
    sinon.stub(SequelizeRepository, 'rollbackTransaction').resolves();
    sinon.stub(UserRepository, 'findByEmail').resolves({ id: USER_ID, email: EMAIL, emailVerified: true } as any);
    sinon.stub(UserRepository, 'findPassword').resolves('$2a$10$hash');
    sinon.stub(UserRepository, 'markLoggedIn').resolves(undefined as any);
    sinon.stub(bcrypt, 'compare').resolves(true);
    sinon.stub(AuthService, 'handleOnboard').resolves(undefined as any);
    // Permission computation is orthogonal to the gate; keep it cheap + offline.
    sinon.stub(RoleRepository, 'getPermissionsMapForTenant').resolves({} as any);
    sinon.stub(RoleRepository, 'getCachedCustomizedSlugsForTenant').returns(new Set() as any);
  });

  afterEach(() => sinon.restore());

  // ── Deactivated ('archived') membership is rejected on EVERY channel ─────────
  it("rejects an 'archived' membership on the CRM (web) channel", async () => {
    await assert.rejects(
      () => runSignin('archived', 'web'),
      (err: any) => {
        assert.strictEqual(err.messageCode, 'auth.accountDisabled');
        return true;
      },
    );
  });

  it("rejects an 'archived' guard on the worker channel (no worker token for a deactivated guard)", async () => {
    await assert.rejects(
      () => runSignin('archived', 'worker'),
      (err: any) => {
        assert.strictEqual(err.messageCode, 'auth.accountDisabled');
        return true;
      },
    );
  });

  it("rejects an 'archived' supervisor on the supervisor channel", async () => {
    await assert.rejects(
      () => runSignin('archived', 'supervisor', ['securitySupervisor']),
      (err: any) => {
        assert.strictEqual(err.messageCode, 'auth.accountDisabled');
        return true;
      },
    );
  });

  // ── Active membership authenticates normally on every channel ────────────────
  it("lets an 'active' membership sign in on the web channel (returns a token)", async () => {
    const res: any = await runSignin('active', 'web', ['admin']);
    assert.ok(res && typeof res.token === 'string' && res.token.length > 0);
    assert.ok(res.user && res.user.tenant, 'tenant context expected on the payload');
  });

  it("lets an 'active' guard sign in on the worker channel (returns a token)", async () => {
    const res: any = await runSignin('active', 'worker');
    assert.ok(res && typeof res.token === 'string' && res.token.length > 0);
  });

  // ── Invitation flow is NOT blocked (an invited user must authenticate to accept)
  it("does NOT block an 'invited' membership (invitation-accept flow must work)", async () => {
    const res: any = await runSignin('invited', 'web', ['admin']);
    assert.ok(res && typeof res.token === 'string' && res.token.length > 0);
  });

  it("does NOT block a 'pending' membership", async () => {
    const res: any = await runSignin('pending', 'web', ['admin']);
    assert.ok(res && typeof res.token === 'string' && res.token.length > 0);
  });
});
