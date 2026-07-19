/**
 * Unit tests — auth channel ↔ role enforcement wiring.
 *
 * Two enforcement fronts are covered, both WITHOUT a real DB or network:
 *
 *  A) The sign-in HANDLER (src/api/auth/authSignIn.ts). We sinon-stub
 *     AuthService.signin to return a crafted auth payload, feed a fake req/res,
 *     and assert whether the handler responds success (200) or is rejected with
 *     403 by the REAL assertChannelAllowed(normalizeAppChannel(app)) call it
 *     wires up. This proves the CRM (app:'web') refuses field/customer accounts,
 *     the field apps refuse office/admin accounts, and superadmins pass anywhere.
 *
 *  B) The per-request GATE decision in AuthService.findByToken. That method is
 *     large (JWT verify + DB hydrate), so we test the DECISION it encodes rather
 *     than the method: shouldReject = tokenCh === 'web' && !hasSuperadminRole(u)
 *     && isFieldOnlyUser(u), using the REAL helpers from security/channelAccess.
 *     This proves worker/supervisor tokens (ch !== 'web') are NEVER rejected —
 *     the mobile apps must keep working — while field-only 'web' tokens are.
 *
 * No production code is modified.
 *
 * Run:
 *   npm run test:unit
 *   (cross-env NODE_ENV=test TS_NODE_PROJECT=tsconfig.test.json \
 *     npx mocha -r ts-node/register 'tests/unit/auth/authChannelGate.test.ts' --exit)
 */

import assert from 'assert';
import sinon from 'sinon';

import authSignIn from '../../../src/api/auth/authSignIn';
import AuthService from '../../../src/services/auth/authService';
import {
  isFieldOnlyUser,
  hasSuperadminRole,
} from '../../../src/security/channelAccess';

// ────────────────────────── fake req / res helpers ──────────────────────────

/** Minimal Express-shaped req the handler reads (body fields + language). */
function makeReq(app: string | undefined, overrides: any = {}) {
  return {
    body: {
      email: 'user@example.com',
      password: 'Passw0rd!',
      invitationToken: undefined,
      tenantId: undefined,
      app,
      ...overrides,
    },
    language: 'en',
    // req.database is only touched by the best-effort failed-login audit inside
    // a try/catch; leaving it undefined is harmless (the throw is swallowed).
  } as any;
}

/**
 * Captures whatever ApiResponseHandler.success/error do to the response:
 *   success → res.status(200).send(payload)
 *   403     → res.status(403).json({ ... })
 */
function makeRes() {
  const res: any = {
    statusCode: null as number | null,
    body: undefined as any,
    finished: false,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    send(payload: any) {
      this.body = payload;
      this.finished = true;
      return this;
    },
    json(payload: any) {
      this.body = payload;
      this.finished = true;
      return this;
    },
    sendStatus(code: number) {
      this.statusCode = code;
      this.finished = true;
      return this;
    },
    header() {
      return this;
    },
  };
  return res;
}

// Crafted sign-in payloads (the shape authSignIn reads: payload.user.tenant.roles
// for tenant users, payload.user.roles for the superadmin path).
const tenantPayload = (roles: string[]) => ({
  token: 't0ken',
  user: { id: 'u1', email: 'user@example.com', tenant: { roles } },
});
const superadminPayload = () => ({
  token: 't0ken',
  user: { id: 'u1', email: 'super@example.com', roles: ['superadmin'] },
});

// ─────────────────────────── A) sign-in handler ─────────────────────────────
describe('authSignIn · channel ↔ role enforcement (handler)', () => {
  let signinStub: sinon.SinonStub;

  afterEach(() => {
    sinon.restore();
  });

  /** Stub AuthService.signin → payload, run the handler, return the fake res. */
  async function run(payload: any, app: string | undefined) {
    signinStub = sinon.stub(AuthService, 'signin').resolves(payload as any);
    const req = makeReq(app);
    const res = makeRes();
    await authSignIn(req, res);
    return res;
  }

  it('guard + app:web → 403 (must use the worker app, not the CRM)', async () => {
    const res = await run(tenantPayload(['securityGuard']), 'web');
    assert.strictEqual(res.statusCode, 403);
    assert.ok(res.body && res.body.code === 403, 'expected a 403 error body');
  });

  it('guard + app:worker → success (200)', async () => {
    const res = await run(tenantPayload(['securityGuard']), 'worker');
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.token, 't0ken');
  });

  it('admin + app:web → success (200)', async () => {
    const res = await run(tenantPayload(['admin']), 'web');
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.token, 't0ken');
  });

  it('admin + app:worker → 403 (office account may not use a field app)', async () => {
    const res = await run(tenantPayload(['admin']), 'worker');
    assert.strictEqual(res.statusCode, 403);
  });

  it('securitySupervisor + app:supervisor → success (200)', async () => {
    const res = await run(tenantPayload(['securitySupervisor']), 'supervisor');
    assert.strictEqual(res.statusCode, 200);
  });

  it('securitySupervisor + app:web → 403', async () => {
    const res = await run(tenantPayload(['securitySupervisor']), 'web');
    assert.strictEqual(res.statusCode, 403);
  });

  it('customer-only + app:web → 403', async () => {
    const res = await run(tenantPayload(['customer']), 'web');
    assert.strictEqual(res.statusCode, 403);
  });

  it('dual [admin, securityGuard] + app:web → success (office role keeps CRM)', async () => {
    const res = await run(tenantPayload(['admin', 'securityGuard']), 'web');
    assert.strictEqual(res.statusCode, 200);
  });

  it('superadmin (top-level roles, no tenant) + app:web → success', async () => {
    const res = await run(superadminPayload(), 'web');
    assert.strictEqual(res.statusCode, 200);
  });

  it('superadmin + app:worker → success (allowed on every channel)', async () => {
    const res = await run(superadminPayload(), 'worker');
    assert.strictEqual(res.statusCode, 200);
  });

  it('missing app defaults to web → guard rejected 403, admin allowed 200', async () => {
    const guard = await run(tenantPayload(['securityGuard']), undefined);
    assert.strictEqual(guard.statusCode, 403);
    sinon.restore();
    const admin = await run(tenantPayload(['admin']), undefined);
    assert.strictEqual(admin.statusCode, 200);
  });
});

// ───────────────── B) per-request gate DECISION (findByToken) ────────────────
//
// The gate in AuthService.findByToken rejects (Error401 'auth.channelNotAllowed')
// exactly when:
//     tokenCh === 'web' && !hasSuperadminRole(user) && isFieldOnlyUser(user)
// We exercise that boolean with the REAL helpers so the decision table is
// pinned. The key guarantee: any token whose channel is NOT 'web' (the worker &
// supervisor apps) is never rejected regardless of role.
function gateWouldReject(user: any, tokenCh: string): boolean {
  return tokenCh === 'web' && !hasSuperadminRole(user) && isFieldOnlyUser(user);
}

// User shapes mirror the hydrated findById row (a `tenants` array of role sets).
const guardUser = { tenants: [{ roles: ['securityGuard'] }] };
const supervisorUser = { tenants: [{ roles: ['securitySupervisor'] }] };
const customerUser = { tenants: [{ roles: ['customer'] }] };
const adminUser = { tenants: [{ roles: ['admin'] }] };
const superadminUser = { tenants: [{ roles: ['superadmin'] }] };
const rolelessUser = { tenants: [] as any[] };
const dualUser = { tenants: [{ roles: ['securityGuard', 'admin'] }] };

describe('findByToken gate · channel ↔ role DECISION', () => {
  it("guard token ch='web' → REJECT (guard ejected from the CRM)", () => {
    assert.strictEqual(gateWouldReject(guardUser, 'web'), true);
  });

  it("guard token ch='worker' → ALLOW (worker app must keep working)", () => {
    assert.strictEqual(gateWouldReject(guardUser, 'worker'), false);
  });

  it("supervisor token ch='supervisor' → ALLOW (supervisor app keeps working)", () => {
    assert.strictEqual(gateWouldReject(supervisorUser, 'supervisor'), false);
  });

  it("supervisor token ch='web' → REJECT", () => {
    assert.strictEqual(gateWouldReject(supervisorUser, 'web'), true);
  });

  it("customer token ch='web' → REJECT", () => {
    assert.strictEqual(gateWouldReject(customerUser, 'web'), true);
  });

  it("admin token ch='web' → ALLOW (office account belongs on the CRM)", () => {
    assert.strictEqual(gateWouldReject(adminUser, 'web'), false);
  });

  it("superadmin token ch='web' → ALLOW (cross-cutting exemption)", () => {
    assert.strictEqual(gateWouldReject(superadminUser, 'web'), false);
  });

  it("roleless token ch='web' → ALLOW (harmless restricted dashboard)", () => {
    assert.strictEqual(gateWouldReject(rolelessUser, 'web'), false);
  });

  it("dual guard+admin token ch='web' → ALLOW (office role keeps CRM)", () => {
    assert.strictEqual(gateWouldReject(dualUser, 'web'), false);
  });

  // Sanity: the helpers themselves classify the roles the way the gate assumes.
  it('isFieldOnlyUser / hasSuperadminRole classify each shape correctly', () => {
    assert.strictEqual(isFieldOnlyUser(guardUser), true);
    assert.strictEqual(isFieldOnlyUser(supervisorUser), true);
    assert.strictEqual(isFieldOnlyUser(customerUser), true);
    assert.strictEqual(isFieldOnlyUser(adminUser), false);
    assert.strictEqual(isFieldOnlyUser(rolelessUser), false);
    assert.strictEqual(isFieldOnlyUser(dualUser), false);
    assert.strictEqual(hasSuperadminRole(superadminUser), true);
    assert.strictEqual(hasSuperadminRole(guardUser), false);
  });
});
