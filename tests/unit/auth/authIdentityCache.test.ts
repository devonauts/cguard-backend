/**
 * Unit tests — auth identity cache (lib/authIdentityCache).
 *
 * Verifies the short-TTL per-user identity cache that fronts the expensive
 * findById join on the auth hot path: clone isolation (no shared-object leak),
 * TTL expiry, the AUTH_IDENTITY_CACHE_MS kill-switch, invalidation, and the
 * size cap. No DB, no network.
 *
 * Run:
 *   cross-env NODE_ENV=test TS_NODE_PROJECT=tsconfig.test.json \
 *     npx mocha -r ts-node/register \
 *     'tests/unit/auth/authIdentityCache.test.ts' --exit --timeout 20000
 */
import assert from 'assert';
import {
  getCachedIdentity,
  setCachedIdentity,
  invalidateCachedIdentity,
  clearAuthIdentityCache,
  isAuthIdentityCacheEnabled,
} from '../../../src/lib/authIdentityCache';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('authIdentityCache', () => {
  const savedEnv = process.env.AUTH_IDENTITY_CACHE_MS;
  afterEach(() => {
    clearAuthIdentityCache();
    if (savedEnv === undefined) delete process.env.AUTH_IDENTITY_CACHE_MS;
    else process.env.AUTH_IDENTITY_CACHE_MS = savedEnv;
  });

  it('stores and returns a hydrated identity', () => {
    process.env.AUTH_IDENTITY_CACHE_MS = '20000';
    setCachedIdentity('u1', { id: 'u1', fullName: 'Ana', tenants: [{ tenantId: 't1', roles: ['admin'] }] });
    const got = getCachedIdentity('u1');
    assert.ok(got);
    assert.strictEqual(got.fullName, 'Ana');
    assert.strictEqual(got.tenants[0].tenantId, 't1');
  });

  it('returns a DEEP CLONE — mutating the result never leaks into the cache', () => {
    process.env.AUTH_IDENTITY_CACHE_MS = '20000';
    setCachedIdentity('u2', { id: 'u2', emailVerified: false, tenants: [{ roles: ['guard'] }] });
    const a = getCachedIdentity('u2');
    a.emailVerified = true;                 // per-request mutation
    a.clientAccountId = 'leak';             // per-request attach
    a.tenants[0].roles.push('admin');       // nested mutation
    const b = getCachedIdentity('u2');
    assert.strictEqual(b.emailVerified, false, 'scalar mutation leaked');
    assert.strictEqual(b.clientAccountId, undefined, 'attached field leaked');
    assert.deepStrictEqual(b.tenants[0].roles, ['guard'], 'nested mutation leaked');
  });

  it('expires after the TTL', async () => {
    process.env.AUTH_IDENTITY_CACHE_MS = '15';
    setCachedIdentity('u3', { id: 'u3' });
    assert.ok(getCachedIdentity('u3'), 'should be present within TTL');
    await sleep(45);
    assert.strictEqual(getCachedIdentity('u3'), null, 'should be gone after TTL');
  });

  it('kill-switch: AUTH_IDENTITY_CACHE_MS=0 disables caching entirely', () => {
    process.env.AUTH_IDENTITY_CACHE_MS = '0';
    assert.strictEqual(isAuthIdentityCacheEnabled(), false);
    setCachedIdentity('u4', { id: 'u4' });
    assert.strictEqual(getCachedIdentity('u4'), null);
  });

  it('invalidate drops a cached identity immediately', () => {
    process.env.AUTH_IDENTITY_CACHE_MS = '20000';
    setCachedIdentity('u5', { id: 'u5' });
    assert.ok(getCachedIdentity('u5'));
    invalidateCachedIdentity('u5');
    assert.strictEqual(getCachedIdentity('u5'), null);
  });

  it('defaults to enabled (20s) when the env var is unset', () => {
    delete process.env.AUTH_IDENTITY_CACHE_MS;
    assert.strictEqual(isAuthIdentityCacheEnabled(), true);
    setCachedIdentity('u6', { id: 'u6' });
    assert.ok(getCachedIdentity('u6'));
  });

  it('does not cache non-serializable users', () => {
    process.env.AUTH_IDENTITY_CACHE_MS = '20000';
    const circular: any = { id: 'u7' };
    circular.self = circular; // JSON.stringify throws
    setCachedIdentity('u7', circular);
    assert.strictEqual(getCachedIdentity('u7'), null);
  });
});
