/**
 * Unit tests: single active session per app channel (seat enforcement).
 *
 * Covers services/auth/sessionService:
 *   • normalizeChannel — whitelist + web default
 *   • parseActiveSessions — tolerant JSON parsing
 *   • isSessionExemptEmail — demo-tenant accounts never superseded
 *   • hasSuperadminRole — platform staff exemption
 *   • mintSessionClaims — rotates ONLY its channel's sid, preserves others,
 *     returns {} for exempt accounts (stubbed db)
 *
 * Run: npm run test:unit
 */

import assert from 'assert';
import sinon from 'sinon';

import {
  normalizeChannel,
  parseActiveSessions,
  isSessionExemptEmail,
  hasSuperadminRole,
  mintSessionClaims,
} from '../../../src/services/auth/sessionService';

describe('sessionService (single active session per channel)', () => {
  afterEach(() => sinon.restore());

  it('normalizeChannel whitelists channels and defaults to web', () => {
    assert.strictEqual(normalizeChannel('worker'), 'worker');
    assert.strictEqual(normalizeChannel('SUPERVISOR'), 'supervisor');
    assert.strictEqual(normalizeChannel('web'), 'web');
    assert.strictEqual(normalizeChannel('client'), 'web'); // customer app has its own mechanism
    assert.strictEqual(normalizeChannel(''), 'web');
    assert.strictEqual(normalizeChannel(undefined), 'web');
    assert.strictEqual(normalizeChannel({ evil: 1 }), 'web');
  });

  it('parseActiveSessions tolerates null, garbage, and objects', () => {
    assert.deepStrictEqual(parseActiveSessions(null), {});
    assert.deepStrictEqual(parseActiveSessions('not-json'), {});
    assert.deepStrictEqual(parseActiveSessions('{"web":"a"}'), { web: 'a' });
    assert.deepStrictEqual(parseActiveSessions({ worker: 'b' }), { worker: 'b' });
    assert.deepStrictEqual(parseActiveSessions('[1,2]' as any), [1, 2] as any);
  });

  it('isSessionExemptEmail exempts only demo-tenant accounts', () => {
    assert.strictEqual(isSessionExemptEmail('guardia.dia@demo.cguardpro.com'), true);
    assert.strictEqual(isSessionExemptEmail('ADMIN@DEMO.CGUARDPRO.COM'), true);
    assert.strictEqual(isSessionExemptEmail('someone@cguardpro.com'), false);
    assert.strictEqual(isSessionExemptEmail('demo.cguardpro.com@gmail.com'), false);
    assert.strictEqual(isSessionExemptEmail(undefined), false);
  });

  it('hasSuperadminRole detects the role across tenant entries', () => {
    assert.strictEqual(hasSuperadminRole({ tenants: [{ roles: ['admin'] }, { roles: ['superadmin'] }] }), true);
    assert.strictEqual(hasSuperadminRole({ tenants: [{ roles: ['SUPER_ADMIN'] }] }), true);
    assert.strictEqual(hasSuperadminRole({ tenants: [{ roles: ['securityGuard'] }] }), false);
    assert.strictEqual(hasSuperadminRole({ tenants: [] }), false);
    assert.strictEqual(hasSuperadminRole({}), false);
    assert.strictEqual(hasSuperadminRole(null), false);
  });

  it('mintSessionClaims rotates its channel and PRESERVES the others', async () => {
    const update = sinon.stub().resolves();
    const db = {
      user: {
        findByPk: sinon.stub().resolves({ activeSessionIds: '{"web":"old-web","worker":"old-worker"}' }),
        update,
      },
    };

    const claims = await mintSessionClaims(db, { id: 'u1', email: 'a@b.com' }, 'worker');

    assert.strictEqual(claims.ch, 'worker');
    assert.ok(claims.sid && claims.sid.length >= 32, 'mints a uuid sid');
    assert.notStrictEqual(claims.sid, 'old-worker');

    const written = JSON.parse(update.firstCall.args[0].activeSessionIds);
    assert.strictEqual(written.web, 'old-web', 'web channel untouched');
    assert.strictEqual(written.worker, claims.sid, 'worker channel rotated');
    assert.deepStrictEqual(update.firstCall.args[1].where, { id: 'u1' });
  });

  it('mintSessionClaims starts a fresh map when none exists', async () => {
    const update = sinon.stub().resolves();
    const db = {
      user: {
        findByPk: sinon.stub().resolves({ activeSessionIds: null }),
        update,
      },
    };

    const claims = await mintSessionClaims(db, { id: 'u2', email: 'a@b.com' }, 'web');
    const written = JSON.parse(update.firstCall.args[0].activeSessionIds);
    assert.deepStrictEqual(Object.keys(written), ['web']);
    assert.strictEqual(written.web, claims.sid);
  });

  it('mintSessionClaims is a no-op {} for demo accounts', async () => {
    const db = { user: { findByPk: sinon.stub(), update: sinon.stub() } };
    const claims = await mintSessionClaims(db, { id: 'u3', email: 'admin@demo.cguardpro.com' }, 'web');
    assert.deepStrictEqual(claims, {});
    sinon.assert.notCalled(db.user.findByPk);
    sinon.assert.notCalled(db.user.update);
  });
});
