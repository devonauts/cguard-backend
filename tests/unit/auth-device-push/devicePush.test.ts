/**
 * Unit tests — auth-device-push domain (device registration + FCM push routing).
 *
 * Mirrors backend/src/services/communication/__tests__/routing.test.ts: an
 * in-memory fake `db` (no MySQL, no network) drives the REAL services. The only
 * external transport stubbed is firebase-admin (via FIREBASE_SERVICE_ACCOUNT not
 * being set → sendToTokens is a safe no-op), so the device resolution / app
 * scoping / count logic is what's actually under test.
 *
 * Coverage:
 *   registerGuardDevice (guardDeviceService — the bind/flag policy):
 *     1.  First device for a guard BINDS (isBound + not flagged).
 *     2.  Re-reporting the SAME bound device clears a stale flag, no mismatch.
 *     3.  A DIFFERENT device is FLAGGED (mismatch) but never blocked.
 *     4.  pushToken is upserted onto the device row (makes push reachable).
 *     5.  resetGuardBinding unbinds + clears flags for the whole guard.
 *
 *   pushService (device resolution + app scoping that the broadcast + per-user
 *   sends and the superadmin audience count all share):
 *     6.  countAllDevices breaks the fleet down by app + transport.
 *     7.  pushToTenant targets WORKER devices only (NULL app = worker; client excluded).
 *     8.  pushToUser resolves THIS user's tokens by userId.
 *     9.  pushToClientAccounts resolves by clientAccountId OR userId (deduped).
 *
 * Run:
 *   cd backend && cross-env NODE_ENV=test TS_NODE_PROJECT=tsconfig.test.json \
 *     npx mocha -r ts-node/register \
 *     'tests/unit/auth-device-push/devicePush.test.ts' --exit --timeout 20000
 */
import assert from 'assert';
import sinon from 'sinon';
import { Op } from 'sequelize';

import { registerGuardDevice, resetGuardBinding } from '../../../src/services/guardDeviceService';
import {
  countAllDevices,
  pushToTenant,
  pushToUser,
  pushToClientAccounts,
} from '../../../src/services/pushService';

const TENANT_A = 'tenant-A';
const TENANT_B = 'tenant-B';

// ───────────────────────────── In-memory fake DB ─────────────────────────────

let _seq = 0;
function makeRow(data: any) {
  const row: any = {
    ...data,
    async update(patch: any) {
      Object.assign(this, patch);
      return this;
    },
    async destroy() {
      (row as any)._destroyed = true;
      return this;
    },
  };
  return row;
}

/**
 * A tiny Sequelize-shaped stub for deviceIdInformation + user. Supports the
 * subset of WHERE clauses the real services use, including the `[Op.or]` /
 * `[Op.in]` / `[Op.ne]` operators that the app-scoping queries rely on.
 */
function buildDb(
  devices: Array<Record<string, any>> = [],
  users: Record<string, any> = {},
) {
  const rows: any[] = devices.map((d) =>
    makeRow({ id: d.id || `dev-${++_seq}`, isBound: false, flagged: false, ...d }),
  );

  function matchOr(row: any, orClauses: any[]): boolean {
    return orClauses.some((c) => matchWhere(row, c));
  }

  function matchWhere(row: any, where: any): boolean {
    if (!where) return true;
    for (const key of Object.keys(where)) {
      // The Op.or symbol key.
      if ((key as any) === Op.or || key === (Op.or as any)) continue;
    }
    // Op.or is a Symbol → handled separately below.
    const orVal = (where as any)[Op.or];
    if (orVal && !matchOr(row, orVal)) return false;

    for (const key of Object.keys(where)) {
      const cond = where[key];
      if (cond && typeof cond === 'object') {
        if ((Op.ne as any) in cond) {
          if (row[key] === cond[Op.ne as any]) return false;
          continue;
        }
        if ((Op.in as any) in cond) {
          if (!cond[Op.in as any].includes(row[key])) return false;
          continue;
        }
      }
      // Plain equality (null included).
      if (cond === null) {
        if (row[key] !== null && row[key] !== undefined) return false;
      } else if (row[key] !== cond) {
        return false;
      }
    }
    return true;
  }

  const deviceIdInformation = {
    async findOne({ where, order }: any) {
      let matches = rows.filter((r) => !r._destroyed && matchWhere(r, where));
      if (order && order.length) {
        const [col, dir] = order[0];
        matches = matches.slice().sort((a, b) => {
          const av = a[col] ?? 0;
          const bv = b[col] ?? 0;
          if (av === bv) return 0;
          return (av > bv ? 1 : -1) * (dir === 'DESC' ? -1 : 1);
        });
      }
      return matches[0] || null;
    },
    async findAll({ where }: any = {}) {
      return rows.filter((r) => !r._destroyed && matchWhere(r, where || {}));
    },
    async create(data: any) {
      const row = makeRow({ id: `dev-${++_seq}`, isBound: false, flagged: false, ...data });
      rows.push(row);
      return row;
    },
    async findOrCreate({ where, defaults }: any) {
      const found = rows.find((r) => !r._destroyed && matchWhere(r, where));
      if (found) return [found, false];
      const row = makeRow({ id: `dev-${++_seq}`, isBound: false, flagged: false, ...defaults });
      rows.push(row);
      return [row, true];
    },
    async update(patch: any, { where }: any) {
      const matches = rows.filter((r) => !r._destroyed && matchWhere(r, where));
      matches.forEach((r) => Object.assign(r, patch));
      return [matches.length];
    },
    _rows: rows,
  };

  const user = {
    async findByPk(id: string) {
      const u = users[id];
      return u ? makeRow({ id, ...u }) : null;
    },
  };

  return { deviceIdInformation, user };
}

// ─────────────────────────────── Tests ───────────────────────────────────────

describe('auth-device-push — registerGuardDevice (bind/flag policy)', () => {
  afterEach(() => sinon.restore());

  it('binds the FIRST device a guard reports (isBound, not flagged)', async () => {
    const db = buildDb();
    const { record, bound, mismatch } = await registerGuardDevice(db, TENANT_A, 'u1', {
      deviceId: 'dev-aaa',
      platform: 'ios',
      model: 'iPhone 15',
    });

    assert.strictEqual(bound, true, 'first device should bind');
    assert.strictEqual(mismatch, false);
    assert.strictEqual(record.isBound, true);
    assert.strictEqual(record.flagged, false);
    assert.strictEqual(record.userId, 'u1');
    assert.strictEqual(record.deviceId, 'dev-aaa');
  });

  it('re-reporting the SAME bound device clears a stale flag and is not a mismatch', async () => {
    const db = buildDb();
    await registerGuardDevice(db, TENANT_A, 'u1', { deviceId: 'dev-aaa' });
    // Manually mark it flagged to prove a same-device re-report clears it.
    db.deviceIdInformation._rows[0].flagged = true;

    const { bound, mismatch, record } = await registerGuardDevice(db, TENANT_A, 'u1', {
      deviceId: 'dev-aaa',
    });
    assert.strictEqual(bound, true);
    assert.strictEqual(mismatch, false);
    assert.strictEqual(record.flagged, false, 'stale flag must be cleared');
  });

  it('FLAGS a different device (mismatch) without blocking it', async () => {
    const db = buildDb();
    await registerGuardDevice(db, TENANT_A, 'u1', { deviceId: 'dev-aaa' });

    const { bound, mismatch, record } = await registerGuardDevice(db, TENANT_A, 'u1', {
      deviceId: 'dev-bbb',
      model: 'Galaxy S24',
    });

    assert.strictEqual(mismatch, true, 'a non-bound device must be flagged');
    assert.strictEqual(bound, false);
    assert.strictEqual(record.flagged, true);
    assert.ok(record.lastMismatchAt, 'lastMismatchAt should be stamped');
    // The original device is still the bound one.
    const orig = db.deviceIdInformation._rows.find((r: any) => r.deviceId === 'dev-aaa');
    assert.strictEqual(orig.isBound, true);
  });

  it('upserts the FCM pushToken onto the device row (makes push reachable)', async () => {
    const db = buildDb();
    const { record } = await registerGuardDevice(db, TENANT_A, 'u1', {
      deviceId: 'dev-aaa',
      pushToken: 'fcm-token-123',
    });
    assert.strictEqual(record.pushToken, 'fcm-token-123');

    // A later report with a fresh token overwrites it (token rotation).
    const { record: r2 } = await registerGuardDevice(db, TENANT_A, 'u1', {
      deviceId: 'dev-aaa',
      pushToken: 'fcm-token-456',
    });
    assert.strictEqual(r2.pushToken, 'fcm-token-456');
  });

  it('resetGuardBinding unbinds + clears flags for the whole guard', async () => {
    const db = buildDb();
    await registerGuardDevice(db, TENANT_A, 'u1', { deviceId: 'dev-aaa' }); // bound
    await registerGuardDevice(db, TENANT_A, 'u1', { deviceId: 'dev-bbb' }); // flagged
    const boundRow = db.deviceIdInformation._rows.find((r: any) => r.deviceId === 'dev-aaa');

    const { userId, cleared } = await resetGuardBinding(db, TENANT_A, boundRow.id, 'admin-1');
    assert.strictEqual(userId, 'u1');
    assert.ok(cleared >= 1);
    for (const r of db.deviceIdInformation._rows) {
      assert.strictEqual(r.isBound, false, 'all devices unbound');
      assert.strictEqual(r.flagged, false, 'all flags cleared');
    }
  });

  it('isolates the bind across tenants (same user id, different tenant rebinds)', async () => {
    const db = buildDb();
    const a = await registerGuardDevice(db, TENANT_A, 'u1', { deviceId: 'dev-aaa' });
    const b = await registerGuardDevice(db, TENANT_B, 'u1', { deviceId: 'dev-bbb' });
    assert.strictEqual(a.bound, true);
    assert.strictEqual(b.bound, true, 'a different tenant binds independently');
    assert.strictEqual(a.mismatch, false);
    assert.strictEqual(b.mismatch, false);
  });
});

describe('auth-device-push — pushService device resolution + app scoping', () => {
  // No FIREBASE_SERVICE_ACCOUNT in the test env → sendToTokens is a no-op, so
  // these assert the DEVICE RESOLUTION / SCOPING (what each send targets), which
  // is the real contract the superadmin audience + per-user pushes depend on.
  beforeEach(() => {
    delete process.env.FIREBASE_SERVICE_ACCOUNT;
    delete process.env.FIREBASE_SERVICE_ACCOUNT_FILE;
  });
  afterEach(() => sinon.restore());

  it('countAllDevices breaks the fleet down by app + transport', async () => {
    const db = buildDb([
      { tenantId: TENANT_A, userId: 'u1', app: 'worker', pushToken: 'fcm-1' },
      { tenantId: TENANT_A, userId: 'u2', app: null, deviceId: 'leg-1' }, // legacy → worker, fcm
      { tenantId: TENANT_B, userId: 'c1', app: 'client', apnsToken: 'apns-1' },
      { tenantId: TENANT_B, userId: 'c2', app: 'client', pushToken: 'fcm-2' }, // client via fcm
      { tenantId: TENANT_B, userId: 'x1', app: 'worker' }, // no token → not counted
    ]);

    const counts = await countAllDevices(db);
    assert.strictEqual(counts.worker, 2, 'worker = explicit worker + legacy NULL app');
    assert.strictEqual(counts.client, 2);
    assert.strictEqual(counts.apns, 1);
    assert.strictEqual(counts.fcm, 3);
    assert.strictEqual(counts.total, 4, 'tokenless device excluded from total');
  });

  it('pushToTenant targets WORKER devices only (client devices excluded)', async () => {
    const db = buildDb([
      { tenantId: TENANT_A, userId: 'u1', app: 'worker', pushToken: 'fcm-w' },
      { tenantId: TENANT_A, userId: 'u2', app: null, pushToken: 'fcm-legacy' },
      { tenantId: TENANT_A, userId: 'c1', app: 'client', pushToken: 'fcm-client' },
    ]);
    const spy = sinon.spy(db.deviceIdInformation, 'findAll');

    await pushToTenant(db, TENANT_A, { title: 'Ronda', body: 'Inicia ronda' });

    // Inspect exactly which rows the scoping query selected.
    const resolved = await spy.returnValues[0];
    const tokens = resolved.map((r: any) => r.pushToken).sort();
    assert.deepStrictEqual(
      tokens,
      ['fcm-legacy', 'fcm-w'],
      'tenant broadcast hits worker + legacy, never the client device',
    );
  });

  it('pushToUser resolves only THIS user/tenant devices', async () => {
    const db = buildDb([
      { tenantId: TENANT_A, userId: 'u1', pushToken: 'fcm-u1' },
      { tenantId: TENANT_A, userId: 'u2', pushToken: 'fcm-u2' },
      { tenantId: TENANT_B, userId: 'u1', pushToken: 'fcm-other-tenant' },
    ]);
    const spy = sinon.spy(db.deviceIdInformation, 'findAll');

    await pushToUser(db, TENANT_A, 'u1', { title: 'Hola', body: 'Mensaje' });

    const resolved = await spy.returnValues[0];
    const tokens = resolved.map((r: any) => r.pushToken);
    assert.deepStrictEqual(tokens, ['fcm-u1'], 'only the requested user in the requested tenant');
  });

  it('pushToUser is a safe no-op when userId is empty', async () => {
    const db = buildDb([{ tenantId: TENANT_A, userId: 'u1', pushToken: 'fcm-u1' }]);
    const res: any = await pushToUser(db, TENANT_A, '', { title: 'x', body: 'y' });
    assert.strictEqual(res.skipped, true);
    assert.strictEqual(res.sent, 0);
  });

  it('pushToClientAccounts resolves by clientAccountId OR userId (deduped, scoped)', async () => {
    const db = buildDb([
      { tenantId: TENANT_A, clientAccountId: 'ca-1', pushToken: 'fcm-ca1' },
      { tenantId: TENANT_A, userId: 'cu-9', pushToken: 'fcm-cu9' },
      { tenantId: TENANT_A, clientAccountId: 'ca-other', pushToken: 'fcm-nope' },
      { tenantId: TENANT_B, clientAccountId: 'ca-1', pushToken: 'fcm-wrong-tenant' },
    ]);
    const spy = sinon.spy(db.deviceIdInformation, 'findAll');

    await pushToClientAccounts(db, TENANT_A, ['ca-1', '', 'ca-1'], ['cu-9'], {
      title: 'Aviso',
      body: 'Cliente',
    });

    const resolved = await spy.returnValues[0];
    const tokens = resolved.map((r: any) => r.pushToken).sort();
    assert.deepStrictEqual(
      tokens,
      ['fcm-ca1', 'fcm-cu9'],
      'resolves the clientAccount AND the user device, only in this tenant',
    );
  });

  it('pushToClientAccounts is a no-op when no ids are supplied', async () => {
    const db = buildDb([{ tenantId: TENANT_A, clientAccountId: 'ca-1', pushToken: 'fcm' }]);
    const res: any = await pushToClientAccounts(db, TENANT_A, [], [], { title: 'x', body: 'y' });
    assert.strictEqual(res.skipped, true);
    assert.strictEqual(res.sent, 0);
  });
});
