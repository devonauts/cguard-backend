/**
 * Unit tests — RBAC permission enforcement (the "permiso denegado da 403" core).
 *
 * Covered (REAL production code):
 *   - PermissionChecker.validateHas / has         legacy role→permission gating
 *   - PermissionChecker effective-set model        grant / deny / admin-floor /
 *                                                  superadmin bypass (behind the
 *                                                  RBAC_EFFECTIVE_MODEL kill-switch)
 *   - computeTenantPermissions                      role-union + customized-empty
 *   - parsePermissionOverrides                      JSON/string/garbage tolerance
 *   - applyUserOverridesAndFloor                    grant/deny precedence + floor
 *
 * These are the invariants an operator relies on: a role that lacks a permission
 * gets a 403 (not a 200), a per-user deny can strip a permission, a grant can add
 * one, and the admin floor can never be denied away (lock-out prevention).
 *
 * Run:
 *   cross-env NODE_ENV=test TS_NODE_PROJECT=tsconfig.test.json \
 *     npx mocha -r ts-node/register \
 *     'tests/unit/op-rbac-settings-kpis/**\/*.test.ts' --exit --timeout 20000
 */

import assert from 'assert';

import PermissionChecker from '../../../src/services/user/permissionChecker';
import Permissions from '../../../src/security/permissions';
import Error403 from '../../../src/errors/Error403';
import {
  computeTenantPermissions,
  parsePermissionOverrides,
  applyUserOverridesAndFloor,
  ADMIN_FLOOR_PERMISSIONS,
  getStaticDefaultsForRole,
} from '../../../src/security/staticRolePermissions';

import { userWithRoles } from './helpers';

const P = Permissions.values;

function checker(user: any, tenantId: string, plan?: string) {
  return new PermissionChecker({
    currentTenant: { id: tenantId, plan },
    language: 'es',
    currentUser: user,
  });
}

// Unique tenant id per assertion keeps the process-global RoleRepository
// permission cache cold (empty map → static-default fallback path).
let _t = 0;
const freshTenant = () => `tenant-rbac-${Date.now()}-${_t++}`;

// ═══════════════════ legacy role→permission gating (default) ═════════════════
describe('op-rbac · PermissionChecker legacy role gating (kill-switch OFF)', () => {
  const savedEnv = process.env.RBAC_EFFECTIVE_MODEL;
  beforeEach(() => {
    delete process.env.RBAC_EFFECTIVE_MODEL; // force legacy path
  });
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.RBAC_EFFECTIVE_MODEL;
    else process.env.RBAC_EFFECTIVE_MODEL = savedEnv;
  });

  it('admin passes settingsEdit (validateHas does NOT throw)', () => {
    const t = freshTenant();
    const c = checker(userWithRoles(['admin'], t), t);
    assert.doesNotThrow(() => c.validateHas(P.settingsEdit));
    assert.strictEqual(c.has(P.settingsEdit), true);
  });

  it('securityGuard is DENIED settingsEdit → Error403 (not silently allowed)', () => {
    const t = freshTenant();
    const c = checker(userWithRoles(['securityGuard'], t), t);
    assert.strictEqual(c.has(P.settingsEdit), false);
    assert.throws(() => c.validateHas(P.settingsEdit), (e: any) => e instanceof Error403 && e.code === 403);
  });

  it('securityGuard still passes read-tier settingsRead (ALL_STAFF_ROLES)', () => {
    const t = freshTenant();
    const c = checker(userWithRoles(['securityGuard'], t), t);
    assert.strictEqual(c.has(P.settingsRead), true);
  });

  it('securityGuard is DENIED securityGuardEdit (supervisor/HR tier) → 403', () => {
    const t = freshTenant();
    const c = checker(userWithRoles(['securityGuard'], t), t);
    assert.strictEqual(c.has(P.securityGuardEdit), false);
    assert.throws(() => c.validateHas(P.securityGuardEdit), (e: any) => e instanceof Error403);
  });

  it('a null current user is denied everything (never a 200)', () => {
    const t = freshTenant();
    const c = checker(null, t);
    assert.strictEqual(c.has(P.settingsRead), false);
    assert.throws(() => c.validateHas(P.settingsRead), (e: any) => e instanceof Error403);
  });

  it('a user active in ANOTHER tenant has no roles here → denied', () => {
    const t = freshTenant();
    // admin, but in a different tenant than the one being checked.
    const c = checker(userWithRoles(['admin'], 'some-other-tenant'), t);
    assert.strictEqual(c.has(P.settingsEdit), false);
  });
});

// ═══════════════════ effective-set model (kill-switch ON) ════════════════════
describe('op-rbac · PermissionChecker effective-set model (kill-switch ON)', () => {
  const savedEnv = process.env.RBAC_EFFECTIVE_MODEL;
  beforeEach(() => {
    process.env.RBAC_EFFECTIVE_MODEL = 'true';
  });
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.RBAC_EFFECTIVE_MODEL;
    else process.env.RBAC_EFFECTIVE_MODEL = savedEnv;
  });

  it('a per-user DENY strips a role-granted permission → 403', () => {
    const t = freshTenant();
    // securityGuard normally has securityGuardRead (ALL_STAFF_ROLES).
    const user = userWithRoles(['securityGuard'], t, {
      permissionOverrides: { deny: ['securityGuardRead'] },
    });
    const c = checker(user, t);
    assert.strictEqual(c.has(P.securityGuardRead), false, 'deny override must remove the permission');
    assert.throws(() => c.validateHas(P.securityGuardRead), (e: any) => e instanceof Error403);
  });

  it('a per-user GRANT adds a permission the role does not confer', () => {
    const t = freshTenant();
    // securityGuard does NOT have settingsEdit by role.
    const user = userWithRoles(['securityGuard'], t, {
      permissionOverrides: { grant: ['settingsEdit'] },
    });
    const c = checker(user, t);
    assert.strictEqual(c.has(P.settingsEdit), true, 'grant override must add the permission');
  });

  it('admin FLOOR permission survives an explicit deny (lock-out prevention)', () => {
    const t = freshTenant();
    // settingsEdit is a floor permission; denying it must be overridden by the floor.
    const user = userWithRoles(['admin'], t, {
      permissionOverrides: { deny: ['settingsEdit'] },
    });
    const c = checker(user, t);
    assert.strictEqual(c.has(P.settingsEdit), true, 'admin floor must re-add settingsEdit');
  });

  it('a NON-floor admin permission CAN be denied (proves deny actually works)', () => {
    const t = freshTenant();
    // auditLogRead is not in ADMIN_FLOOR_PERMISSIONS.
    assert.ok(!ADMIN_FLOOR_PERMISSIONS.includes('auditLogRead'));
    const user = userWithRoles(['admin'], t, {
      permissionOverrides: { deny: ['auditLogRead'] },
    });
    const c = checker(user, t);
    assert.strictEqual(c.has(P.auditLogRead), false, 'non-floor permission must be strippable');
  });

  it('superadmin bypass grants every permission', () => {
    const t = freshTenant();
    const user = userWithRoles(['superadmin'], t, { isSuperadmin: true });
    const c = checker(user, t);
    assert.strictEqual(c.has(P.settingsEdit), true);
    assert.strictEqual(c.has(P.tenantDestroy), true);
    assert.strictEqual(c.has(P.auditLogRead), true);
  });
});

// ═══════════════════ computeTenantPermissions (role union) ═══════════════════
describe('op-rbac · computeTenantPermissions', () => {
  it('unions the static defaults across multiple roles', () => {
    const perms = computeTenantPermissions(null, ['securityGuard', 'dispatcher']);
    const guardOnly = getStaticDefaultsForRole('securityGuard');
    const dispatcherOnly = getStaticDefaultsForRole('dispatcher');
    for (const p of guardOnly) assert.ok(perms.includes(p), `missing guard perm ${p}`);
    for (const p of dispatcherOnly) assert.ok(perms.includes(p), `missing dispatcher perm ${p}`);
    // No duplicates.
    assert.strictEqual(perms.length, new Set(perms).size);
  });

  it('a non-empty DB role map overrides the static defaults for that role', () => {
    const map = { operationsManager: ['onlyThisOne'] };
    const perms = computeTenantPermissions(map, ['operationsManager']);
    assert.deepStrictEqual(perms, ['onlyThisOne']);
  });

  it('a CUSTOMIZED but EMPTY role is authoritative-empty (removed everything sticks)', () => {
    const map = { securityGuard: [] };
    const customized = new Set(['securityGuard']);
    const perms = computeTenantPermissions(map, ['securityGuard'], customized);
    assert.deepStrictEqual(perms, [], 'emptied customized role must not fall back to static defaults');
  });

  it('an EMPTY but NOT-customized role falls back to the static defaults', () => {
    const map = { securityGuard: [] };
    const perms = computeTenantPermissions(map, ['securityGuard']); // no customized set
    assert.deepStrictEqual(perms.sort(), getStaticDefaultsForRole('securityGuard').sort());
  });
});

// ═══════════════════ parsePermissionOverrides ═══════════════════════════════
describe('op-rbac · parsePermissionOverrides', () => {
  it('parses an object with grant/deny arrays', () => {
    const o = parsePermissionOverrides({ grant: ['a', 'b'], deny: ['c'] });
    assert.deepStrictEqual(o.grant, ['a', 'b']);
    assert.deepStrictEqual(o.deny, ['c']);
  });

  it('parses a JSON STRING (the column may store a string)', () => {
    const o = parsePermissionOverrides('{"grant":["x"],"deny":["y"]}');
    assert.deepStrictEqual(o.grant, ['x']);
    assert.deepStrictEqual(o.deny, ['y']);
  });

  it('garbage / null / non-string entries degrade to empty arrays (never throws)', () => {
    assert.deepStrictEqual(parsePermissionOverrides('not json'), { grant: [], deny: [] });
    assert.deepStrictEqual(parsePermissionOverrides(null), { grant: [], deny: [] });
    const o = parsePermissionOverrides({ grant: ['ok', 5, null, {}], deny: 'nope' });
    assert.deepStrictEqual(o.grant, ['ok'], 'non-string grants filtered out');
    assert.deepStrictEqual(o.deny, [], 'non-array deny → empty');
  });
});

// ═══════════════════ applyUserOverridesAndFloor ══════════════════════════════
describe('op-rbac · applyUserOverridesAndFloor', () => {
  it('adds grants and removes denies (deny wins over the base)', () => {
    const out = applyUserOverridesAndFloor(['a', 'b'], { grant: ['c'], deny: ['a'] }, ['securityGuard']);
    const s = new Set(out);
    assert.ok(s.has('b') && s.has('c'));
    assert.ok(!s.has('a'), 'denied permission must be gone');
  });

  it('deny wins even when the SAME id is also granted', () => {
    const out = applyUserOverridesAndFloor([], { grant: ['x'], deny: ['x'] }, null);
    assert.ok(!out.includes('x'), 'deny must win over grant');
  });

  it('re-adds the admin floor for admin holders (cannot be denied away)', () => {
    const out = applyUserOverridesAndFloor([], { deny: [...ADMIN_FLOOR_PERMISSIONS] }, ['admin']);
    for (const p of ADMIN_FLOOR_PERMISSIONS) {
      assert.ok(out.includes(p), `floor permission ${p} must survive for an admin`);
    }
  });

  it('does NOT add the floor for a non-admin holder', () => {
    const out = applyUserOverridesAndFloor([], { deny: [] }, ['securityGuard']);
    assert.strictEqual(out.length, 0, 'non-admin gets no floor');
  });
});
