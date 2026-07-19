/**
 * Unit tests — auth channel-access control (src/security/channelAccess.ts).
 *
 * This is a SECURITY control: it decides which app (channel) an account may
 * sign in through based on its role(s). These tests exhaustively pin the
 * role→channel matrix, the multi-role UNION semantics, the superadmin
 * everywhere-exception, the roleless "CRM-only" allowance, case-insensitivity,
 * unknown-slug handling, and the shape-tolerant user helpers.
 *
 * Pure module — no db, no network. Uses Node's built-in `assert`.
 *
 * Run:
 *   cross-env NODE_ENV=test TS_NODE_PROJECT=tsconfig.test.json \
 *     npx mocha -r ts-node/register \
 *     'tests/unit/auth/channelAccess.test.ts' --exit --timeout 10000
 */

import assert from 'assert';

import {
  normalizeAppChannel,
  userRoleSlugs,
  hasSuperadminRole,
  isFieldOnlyUser,
  assertChannelAllowed,
  AppChannel,
} from '../../../src/security/channelAccess';
import Error403 from '../../../src/errors/Error403';
import { i18n } from '../../../src/i18n';

// ── helpers ──────────────────────────────────────────────────────────────────

const CHANNELS: AppChannel[] = ['web', 'worker', 'supervisor', 'customer'];

/** Assert `assertChannelAllowed(roles, channel)` does NOT throw. */
function expectAllowed(roles: string[], channel: AppChannel) {
  assert.doesNotThrow(
    () => assertChannelAllowed(roles, channel),
    `expected ${JSON.stringify(roles)} to be ALLOWED on '${channel}'`,
  );
}

/**
 * Assert `assertChannelAllowed(roles, channel)` throws an Error403 (code 403).
 * When `expectedCode` is given, also assert the translated message matches that
 * messageCode (Error403 stores only the resolved message; default language is
 * 'es', matching a no-language i18n lookup).
 */
function expectDenied(roles: string[], channel: AppChannel, expectedCode?: string) {
  let thrown: any;
  try {
    assertChannelAllowed(roles, channel);
  } catch (e) {
    thrown = e;
  }
  assert.ok(thrown, `expected ${JSON.stringify(roles)} to be DENIED on '${channel}'`);
  assert.ok(thrown instanceof Error403, 'thrown error should be an Error403');
  assert.strictEqual(thrown.code, 403, 'Error403.code should be 403');
  if (expectedCode) {
    assert.strictEqual(
      thrown.message,
      i18n(undefined, expectedCode),
      `expected messageCode '${expectedCode}' for ${JSON.stringify(roles)} on '${channel}'`,
    );
  }
}

// The single-role home matrix: slug → { home channel, deny messageCode }.
const WEB_ROLES = [
  'admin',
  'operationsManager',
  'hrManager',
  'clientAccountManager',
  'dispatcher',
  'administrativeSupervisor',
  'administrativeAssistant',
  'secretary',
  'custom',
];

const SINGLE_ROLE_HOME: Record<string, { channel: AppChannel; code: string }> = {
  ...Object.fromEntries(
    WEB_ROLES.map((r) => [r, { channel: 'web' as AppChannel, code: 'auth.mustUseCrm' }]),
  ),
  securityGuard: { channel: 'worker', code: 'auth.mustUseWorkerApp' },
  securitySupervisor: { channel: 'supervisor', code: 'auth.mustUseSupervisorApp' },
  customer: { channel: 'customer', code: 'auth.mustUseCustomerApp' },
};

// ─────────────────────── assertChannelAllowed: full matrix ────────────────────

describe('channelAccess · assertChannelAllowed — single-role full matrix', () => {
  for (const [role, home] of Object.entries(SINGLE_ROLE_HOME)) {
    for (const channel of CHANNELS) {
      if (channel === home.channel) {
        it(`[${role}] is ALLOWED on its home channel '${channel}'`, () => {
          expectAllowed([role], channel);
        });
      } else {
        it(`[${role}] is DENIED on '${channel}' → ${home.code}`, () => {
          expectDenied([role], channel, home.code);
        });
      }
    }
  }
});

// ─────────────────────── assertChannelAllowed: multi-role UNION ───────────────

describe('channelAccess · assertChannelAllowed — multi-role UNION', () => {
  it('[admin, securityGuard] → web AND worker allowed; supervisor/customer denied', () => {
    const roles = ['admin', 'securityGuard'];
    expectAllowed(roles, 'web');
    expectAllowed(roles, 'worker');
    expectDenied(roles, 'supervisor');
    expectDenied(roles, 'customer');
  });

  it('[securitySupervisor, admin] → web AND supervisor allowed; worker/customer denied', () => {
    const roles = ['securitySupervisor', 'admin'];
    expectAllowed(roles, 'web');
    expectAllowed(roles, 'supervisor');
    expectDenied(roles, 'worker');
    expectDenied(roles, 'customer');
  });

  it('[securityGuard, securitySupervisor] → worker AND supervisor allowed; web/customer denied', () => {
    const roles = ['securityGuard', 'securitySupervisor'];
    expectAllowed(roles, 'worker');
    expectAllowed(roles, 'supervisor');
    expectDenied(roles, 'web');
    expectDenied(roles, 'customer');
  });

  it('[securityGuard, customer] → worker AND customer allowed; web/supervisor denied', () => {
    const roles = ['securityGuard', 'customer'];
    expectAllowed(roles, 'worker');
    expectAllowed(roles, 'customer');
    expectDenied(roles, 'web');
    expectDenied(roles, 'supervisor');
  });

  it('all field roles together → allowed on every non-web field channel, denied on web', () => {
    const roles = ['securityGuard', 'securitySupervisor', 'customer'];
    expectAllowed(roles, 'worker');
    expectAllowed(roles, 'supervisor');
    expectAllowed(roles, 'customer');
    expectDenied(roles, 'web');
  });
});

// ─────────────────────── assertChannelAllowed: superadmin ─────────────────────

describe('channelAccess · assertChannelAllowed — superadmin allowed everywhere', () => {
  for (const superRole of ['superadmin', 'super_admin', 'SuperAdmin', 'SUPER_ADMIN']) {
    for (const channel of CHANNELS) {
      it(`[${superRole}] allowed on '${channel}'`, () => {
        expectAllowed([superRole], channel);
      });
    }
  }

  it('superadmin combined with a field role is still allowed everywhere', () => {
    const roles = ['securityGuard', 'superadmin'];
    for (const channel of CHANNELS) expectAllowed(roles, channel);
  });
});

// ─────────────────────── assertChannelAllowed: roleless / unknown ─────────────

describe('channelAccess · assertChannelAllowed — roleless & unknown slugs', () => {
  it('roleless [] → web allowed; field apps denied → told to use the CRM', () => {
    expectAllowed([], 'web');
    expectDenied([], 'worker', 'auth.mustUseCrm');
    expectDenied([], 'supervisor', 'auth.mustUseCrm');
    expectDenied([], 'customer', 'auth.mustUseCrm');
  });

  it('null/undefined roles arg is tolerated → treated as roleless (web only)', () => {
    expectAllowed(undefined as any, 'web');
    expectDenied(undefined as any, 'worker', 'auth.mustUseCrm');
    expectAllowed(null as any, 'web');
    expectDenied(null as any, 'customer', 'auth.mustUseCrm');
  });

  it('unknown/custom slug → office by default: CRM allowed, field apps denied', () => {
    const roles = ['not-a-real-role'];
    expectAllowed(roles, 'web');
    expectDenied(roles, 'worker', 'auth.mustUseCrm');
    expectDenied(roles, 'supervisor', 'auth.mustUseCrm');
    expectDenied(roles, 'customer', 'auth.mustUseCrm');
  });

  it('empty-string slugs are filtered → still roleless', () => {
    expectAllowed(['', '   '], 'web');
    expectDenied(['', '   '], 'worker', 'auth.mustUseCrm');
  });

  it('guard + a custom/unknown (office) role → both CRM and worker allowed', () => {
    const roles = ['garbage', 'securityGuard'];
    expectAllowed(roles, 'worker');
    expectAllowed(roles, 'web'); // the custom role grants office/CRM access
  });
});

// ─────────────────────── assertChannelAllowed: case-insensitivity ─────────────

describe('channelAccess · assertChannelAllowed — case-insensitivity', () => {
  it("'SecurityGuard' resolves to worker", () => {
    expectAllowed(['SecurityGuard'], 'worker');
    expectDenied(['SecurityGuard'], 'web', 'auth.mustUseWorkerApp');
  });

  it("'ADMIN' resolves to web", () => {
    expectAllowed(['ADMIN'], 'web');
    expectDenied(['ADMIN'], 'worker', 'auth.mustUseCrm');
  });

  it("mixed-case 'SecuritySupervisor' / 'CuStOmEr' resolve correctly", () => {
    expectAllowed(['SecuritySupervisor'], 'supervisor');
    expectDenied(['SecuritySupervisor'], 'web', 'auth.mustUseSupervisorApp');
    expectAllowed(['CuStOmEr'], 'customer');
    expectDenied(['CuStOmEr'], 'web', 'auth.mustUseCustomerApp');
  });
});

// ─────────────────────── assertChannelAllowed: custom role ────────────────────

describe('channelAccess · assertChannelAllowed — custom role is web-only', () => {
  it("'custom' allowed on web only", () => {
    expectAllowed(['custom'], 'web');
    expectDenied(['custom'], 'worker', 'auth.mustUseCrm');
    expectDenied(['custom'], 'supervisor', 'auth.mustUseCrm');
    expectDenied(['custom'], 'customer', 'auth.mustUseCrm');
  });
});

// ─────────────────────── assertChannelAllowed: language passthrough ───────────

describe('channelAccess · assertChannelAllowed — language passthrough', () => {
  it('a denial uses the requested language for the message', () => {
    let thrown: any;
    try {
      assertChannelAllowed(['securityGuard'], 'web', 'en');
    } catch (e) {
      thrown = e;
    }
    assert.ok(thrown instanceof Error403);
    assert.strictEqual(thrown.message, i18n('en', 'auth.mustUseWorkerApp'));
    // sanity: the en and es strings differ, so this really exercised the language arg
    assert.notStrictEqual(i18n('en', 'auth.mustUseWorkerApp'), i18n('es', 'auth.mustUseWorkerApp'));
  });
});

// ─────────────────────── normalizeAppChannel ─────────────────────────────────

describe('channelAccess · normalizeAppChannel', () => {
  it("passes through 'worker' / 'supervisor' / 'customer'", () => {
    assert.strictEqual(normalizeAppChannel('worker'), 'worker');
    assert.strictEqual(normalizeAppChannel('supervisor'), 'supervisor');
    assert.strictEqual(normalizeAppChannel('customer'), 'customer');
  });

  it("lowercases before matching ('WORKER' → 'worker')", () => {
    assert.strictEqual(normalizeAppChannel('WORKER'), 'worker');
    assert.strictEqual(normalizeAppChannel('Supervisor'), 'supervisor');
    assert.strictEqual(normalizeAppChannel('CUSTOMER'), 'customer');
  });

  it("defaults to 'web' for web/empty/undefined/null/WEB/garbage", () => {
    assert.strictEqual(normalizeAppChannel('web'), 'web');
    assert.strictEqual(normalizeAppChannel('WEB'), 'web');
    assert.strictEqual(normalizeAppChannel(''), 'web');
    assert.strictEqual(normalizeAppChannel(undefined), 'web');
    assert.strictEqual(normalizeAppChannel(null), 'web');
    assert.strictEqual(normalizeAppChannel('nonsense'), 'web');
    assert.strictEqual(normalizeAppChannel(123), 'web');
    assert.strictEqual(normalizeAppChannel({}), 'web');
  });
});

// ─────────────────────── userRoleSlugs — shape tolerance ─────────────────────

describe('channelAccess · userRoleSlugs — shape tolerance', () => {
  it('reads tenant.roles (array), lowercased', () => {
    assert.deepStrictEqual(userRoleSlugs({ tenant: { roles: ['Admin', 'Dispatcher'] } }), [
      'admin',
      'dispatcher',
    ]);
  });

  it('reads tenant.role (singular string) when tenant.roles absent', () => {
    assert.deepStrictEqual(userRoleSlugs({ tenant: { role: 'securityGuard' } }), ['securityguard']);
  });

  it('reads tenants[].roles across the flattened array', () => {
    const slugs = userRoleSlugs({
      tenants: [{ roles: ['admin'] }, { roles: ['securityGuard'] }],
    });
    assert.deepStrictEqual(slugs.sort(), ['admin', 'securityguard']);
  });

  it('reads a top-level comma-separated roles string', () => {
    assert.deepStrictEqual(userRoleSlugs({ roles: 'admin, securityGuard , customer' }), [
      'admin',
      'securityguard',
      'customer',
    ]);
  });

  it('reads a top-level roles array', () => {
    assert.deepStrictEqual(userRoleSlugs({ roles: ['Admin', 'Custom'] }), ['admin', 'custom']);
  });

  it('reads a role object via .name / .slug / .id', () => {
    assert.deepStrictEqual(userRoleSlugs({ role: { name: 'Admin' } }), ['admin']);
    assert.deepStrictEqual(userRoleSlugs({ roles: { slug: 'securityGuard' } }), ['securityguard']);
    assert.deepStrictEqual(userRoleSlugs({ role: { id: 'Dispatcher' } }), ['dispatcher']);
  });

  it('appends superadmin when isSuperadmin flag is set', () => {
    assert.ok(userRoleSlugs({ isSuperadmin: true }).includes('superadmin'));
    assert.deepStrictEqual(userRoleSlugs({ roles: ['admin'], isSuperadmin: true }).sort(), [
      'admin',
      'superadmin',
    ]);
  });

  it('merges roles from every source (tenant + tenants[] + top-level)', () => {
    const slugs = userRoleSlugs({
      tenant: { roles: ['admin'] },
      tenants: [{ role: 'securitySupervisor' }],
      roles: 'customer',
    });
    assert.deepStrictEqual(slugs.sort(), ['admin', 'customer', 'securitysupervisor']);
  });

  it('returns [] for a null/empty/roleless user', () => {
    assert.deepStrictEqual(userRoleSlugs(null), []);
    assert.deepStrictEqual(userRoleSlugs(undefined), []);
    assert.deepStrictEqual(userRoleSlugs({}), []);
    assert.deepStrictEqual(userRoleSlugs({ roles: [] }), []);
    assert.deepStrictEqual(userRoleSlugs({ roles: '' }), []);
  });

  it('ignores role objects lacking name/slug/id', () => {
    assert.deepStrictEqual(userRoleSlugs({ role: { code: 'x' } }), []);
  });
});

// ─────────────────────── hasSuperadminRole ───────────────────────────────────

describe('channelAccess · hasSuperadminRole', () => {
  it('true for superadmin / super_admin (any case)', () => {
    assert.strictEqual(hasSuperadminRole({ roles: 'superadmin' }), true);
    assert.strictEqual(hasSuperadminRole({ roles: 'super_admin' }), true);
    assert.strictEqual(hasSuperadminRole({ roles: 'SuperAdmin' }), true);
    assert.strictEqual(hasSuperadminRole({ tenant: { roles: ['SUPER_ADMIN'] } }), true);
  });

  it('true when the isSuperadmin flag is set', () => {
    assert.strictEqual(hasSuperadminRole({ isSuperadmin: true }), true);
  });

  it('false for non-super roles and roleless users', () => {
    assert.strictEqual(hasSuperadminRole({ roles: 'admin' }), false);
    assert.strictEqual(hasSuperadminRole({ tenant: { roles: ['securityGuard'] } }), false);
    assert.strictEqual(hasSuperadminRole({}), false);
    assert.strictEqual(hasSuperadminRole(null), false);
  });
});

// ─────────────────────── isFieldOnlyUser ─────────────────────────────────────

describe('channelAccess · isFieldOnlyUser', () => {
  it('true for a guard-only user (tenant.roles shape)', () => {
    assert.strictEqual(isFieldOnlyUser({ tenant: { roles: ['securityGuard'] } }), true);
  });

  it('true for a customer-only user (tenants[].roles shape)', () => {
    assert.strictEqual(isFieldOnlyUser({ tenants: [{ roles: ['customer'] }] }), true);
  });

  it('true for a supervisor-only user (roles string shape)', () => {
    assert.strictEqual(isFieldOnlyUser({ roles: 'securitySupervisor' }), true);
  });

  it('true for any all-field combo (guard + supervisor + customer)', () => {
    assert.strictEqual(
      isFieldOnlyUser({ roles: ['securityGuard', 'securitySupervisor', 'customer'] }),
      true,
    );
  });

  it('false for an office admin', () => {
    assert.strictEqual(isFieldOnlyUser({ tenant: { roles: ['admin'] } }), false);
    assert.strictEqual(isFieldOnlyUser({ roles: 'dispatcher' }), false);
  });

  it('false for a custom (web) role', () => {
    assert.strictEqual(isFieldOnlyUser({ roles: 'custom' }), false);
  });

  it('false for a guard+admin dual (retains CRM access)', () => {
    assert.strictEqual(isFieldOnlyUser({ tenant: { roles: ['securityGuard', 'admin'] } }), false);
  });

  it('false for superadmin (role slug and isSuperadmin flag)', () => {
    assert.strictEqual(isFieldOnlyUser({ roles: 'superadmin' }), false);
    assert.strictEqual(isFieldOnlyUser({ isSuperadmin: true }), false);
  });

  it('false (fail-open) for roleless / empty / null users', () => {
    assert.strictEqual(isFieldOnlyUser({}), false);
    assert.strictEqual(isFieldOnlyUser(null), false);
    assert.strictEqual(isFieldOnlyUser({ roles: [] }), false);
  });

  // A custom tenant role has a slugified name (e.g. 'jefe-de-turno') that is not
  // in the known field/office map. It defaults to office/CRM, so an account whose
  // only roles are unknown/custom is NOT field-only — consistent with
  // assertChannelAllowed(['garbage'], 'web') which ALLOWS web. This prevents a
  // legit custom-role admin from being booted from the CRM by the /auth/me gate.
  it('false for a user whose only role is unknown/custom (office by default)', () => {
    assert.strictEqual(isFieldOnlyUser({ roles: ['garbage'] }), false);
    assert.strictEqual(isFieldOnlyUser({ roles: ['jefe-de-turno'] }), false);
  });

  it('false for a guard PLUS a custom/unknown (office) role → keeps CRM access', () => {
    assert.strictEqual(isFieldOnlyUser({ roles: ['securityGuard', 'garbage'] }), false);
  });

  it('is case-insensitive on the role slug', () => {
    assert.strictEqual(isFieldOnlyUser({ roles: 'SecurityGuard' }), true);
    assert.strictEqual(isFieldOnlyUser({ roles: 'ADMIN' }), false);
  });
});
