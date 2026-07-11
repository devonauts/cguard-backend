/**
 * Unit tests: findByToken enforcement of single active session per channel.
 *
 * A token carrying sid/ch is valid only while its sid matches the channel's
 * active session on the user row; a newer sign-in on the same channel
 * supersedes it (401). Legacy tokens (no sid) and other channels pass.
 *
 * Run: npm run test:unit
 */

import assert from 'assert';
import sinon from 'sinon';
import jwt from 'jsonwebtoken';

import AuthService from '../../../src/services/auth/authService';
import UserRepository from '../../../src/database/repositories/userRepository';
import { getConfig } from '../../../src/config';

function makeUser(activeSessionIds: any) {
  return {
    id: 'u1',
    email: 'user@realtenant.com',
    tenants: [{ tenantId: 't1', roles: ['admin'] }],
    activeSessionIds,
    jwtTokenInvalidBefore: null,
  };
}

function signToken(claims: Record<string, any>) {
  return jwt.sign({ id: 'u1', ...claims }, getConfig().AUTH_JWT_SECRET, { expiresIn: '1h' });
}

describe('findByToken — single active session per channel', () => {
  let prevFlag: string | undefined;
  let prevSecret: string | undefined;

  beforeEach(() => {
    prevFlag = process.env.ENFORCE_SINGLE_SESSION;
    prevSecret = process.env.AUTH_JWT_SECRET;
    process.env.ENFORCE_SINGLE_SESSION = 'true';
    // getConfig() returns process.env live, so this is what findByToken verifies with.
    if (!process.env.AUTH_JWT_SECRET) process.env.AUTH_JWT_SECRET = 'test-secret';
  });

  afterEach(() => {
    if (prevFlag === undefined) delete process.env.ENFORCE_SINGLE_SESSION;
    else process.env.ENFORCE_SINGLE_SESSION = prevFlag;
    if (prevSecret === undefined) delete process.env.AUTH_JWT_SECRET;
    else process.env.AUTH_JWT_SECRET = prevSecret;
    sinon.restore();
  });

  it('rejects a superseded token (sid no longer active for its channel)', async () => {
    sinon.stub(UserRepository, 'findById').resolves(makeUser('{"web":"NEW-sid"}'));
    const token = signToken({ sid: 'OLD-sid', ch: 'web' });

    await assert.rejects(
      AuthService.findByToken(token, {}),
      (e: any) => e && e.code === 401,
    );
  });

  it('accepts the token whose sid IS the active session', async () => {
    sinon.stub(UserRepository, 'findById').resolves(makeUser('{"web":"live-sid"}'));
    const token = signToken({ sid: 'live-sid', ch: 'web' });

    const user: any = await AuthService.findByToken(token, {});
    assert.strictEqual(user.id, 'u1');
  });

  it('does not cross channels: a worker token survives a new WEB session', async () => {
    sinon.stub(UserRepository, 'findById').resolves(
      makeUser('{"web":"fresh-web","worker":"my-worker-sid"}'),
    );
    const token = signToken({ sid: 'my-worker-sid', ch: 'worker' });

    const user: any = await AuthService.findByToken(token, {});
    assert.strictEqual(user.id, 'u1');
  });

  it('grandfathers legacy tokens without sid/ch', async () => {
    sinon.stub(UserRepository, 'findById').resolves(makeUser('{"web":"whatever"}'));
    const token = signToken({});

    const user: any = await AuthService.findByToken(token, {});
    assert.strictEqual(user.id, 'u1');
  });

  it('exempts superadmin-role accounts from supersede', async () => {
    const su = makeUser('{"web":"NEW-sid"}');
    (su.tenants[0] as any).roles = ['superadmin'];
    sinon.stub(UserRepository, 'findById').resolves(su);
    const token = signToken({ sid: 'OLD-sid', ch: 'web' });

    const user: any = await AuthService.findByToken(token, {});
    assert.strictEqual(user.id, 'u1');
  });

  it('does nothing when the flag is off', async () => {
    process.env.ENFORCE_SINGLE_SESSION = 'false';
    sinon.stub(UserRepository, 'findById').resolves(makeUser('{"web":"NEW-sid"}'));
    const token = signToken({ sid: 'OLD-sid', ch: 'web' });

    const user: any = await AuthService.findByToken(token, {});
    assert.strictEqual(user.id, 'u1');
  });
});
