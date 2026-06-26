/**
 * Unit tests — incident → owning-client notification routing.
 *
 * These exercise the REAL clientNotifyService (resolveClientRecipients +
 * notifyClient) against an in-memory fake `db` (no MySQL, no network). The only
 * stubbed external calls are the FCM `pushToClientAccounts` transport and the
 * `storePlatformEvent` writer, so the actual site→client resolution logic, the
 * dedupe/union of clientAccount ids + user ids, tenant scoping, and the
 * fire-and-forget contract are all under test.
 *
 * This is the load-bearing core of the "a guard incident reaches the owning
 * client" path: guardMeIncidentCreate.ts calls notifyClient(db, tenantId,
 * { postSiteId, stationId }, ...) and relies on it resolving the right
 * clientAccount via either the station origin or the post-site's businessInfo.
 *
 * Coverage:
 *   1.  Resolve via station.stationOrigin (clientAccount).
 *   2.  Resolve via post-site businessInfo.clientAccount.
 *   3.  Resolve via explicit clientAccountId.
 *   4.  Station with no postSiteId still resolves through its origin.
 *   5.  Station postSiteId backfill → resolves the site's client.
 *   6.  De-dupe when station origin and site client are the same account.
 *   7.  Union of distinct clients (station origin + site client differ).
 *   8.  No linked client → 0 recipients, push never called.
 *   9.  Tenant isolation — a client in another tenant is NOT matched.
 *   10. Missing tenantId → short-circuits to 0.
 *   11. Push payload carries the eventType as `data.type` + title/body/image.
 *   12. clientAccount.userId absent → still pushes by clientAccountId (in-app
 *       platform events skipped since no user id).
 *   13. notifyClient never throws even if push transport rejects.
 *
 * Run:
 *   cross-env NODE_ENV=test TS_NODE_PROJECT=tsconfig.test.json \
 *     npx mocha -r ts-node/register \
 *     'tests/unit/incidents/clientNotify.test.ts' --exit --timeout 20000
 */

import assert from 'assert';
import sinon from 'sinon';

import * as pushService from '../../../src/services/pushService';
import * as platformEventStore from '../../../src/lib/platformEventStore';
import { notifyClient } from '../../../src/services/clientNotifyService';

const TENANT_A = 'tenant-A';
const TENANT_B = 'tenant-B';

// ───────────────────────────── In-memory fake DB ─────────────────────────────
//
// Sequelize-shaped stub for exactly the three models clientNotifyService reads:
// clientAccount, station (with `stationOrigin` include) and businessInfo (with
// `clientAccount` include). Rows live in plain arrays; the `include` aliases are
// resolved by hand to mirror the real associations the service relies on.

interface Seed {
  clientAccounts?: Array<{ id: string; tenantId: string; userId?: string | null; deletedAt?: any }>;
  stations?: Array<{ id: string; tenantId: string; postSiteId?: string | null; stationOriginId?: string | null; deletedAt?: any }>;
  businessInfos?: Array<{ id: string; tenantId: string; clientAccountId?: string | null; deletedAt?: any }>;
}

function matchesWhere(row: any, where: any): boolean {
  for (const [k, v] of Object.entries(where)) {
    if (k === 'deletedAt') {
      // service always queries deletedAt: null → row must be non-deleted.
      if ((row.deletedAt ?? null) !== v) return false;
      continue;
    }
    if (row[k] !== v) return false;
  }
  return true;
}

function buildDb(seed: Seed = {}) {
  const clientAccounts = (seed.clientAccounts || []).map((r) => ({ deletedAt: null, ...r }));
  const stations = (seed.stations || []).map((r) => ({ deletedAt: null, ...r }));
  const businessInfos = (seed.businessInfos || []).map((r) => ({ deletedAt: null, ...r }));

  const findAccount = (id?: string | null, tenantId?: string) =>
    clientAccounts.find(
      (c) => c.id === id && (tenantId === undefined || c.tenantId === tenantId) && (c.deletedAt ?? null) === null,
    ) || null;

  return {
    clientAccount: {
      async findOne({ where, attributes }: any) {
        const row = clientAccounts.find((c) => matchesWhere(c, where));
        if (!row) return null;
        return { id: row.id, userId: row.userId ?? null };
      },
    },
    station: {
      async findOne({ where, include }: any) {
        const row = stations.find((s) => matchesWhere(s, where));
        if (!row) return null;
        const out: any = { id: row.id, postSiteId: row.postSiteId ?? null };
        // Resolve the `stationOrigin` include → clientAccount.
        const wantsOrigin = (include || []).some((i: any) => i.as === 'stationOrigin');
        if (wantsOrigin) {
          const origin = findAccount(row.stationOriginId, row.tenantId);
          out.stationOrigin = origin ? { id: origin.id, userId: origin.userId ?? null } : null;
        }
        return out;
      },
    },
    businessInfo: {
      async findOne({ where, include }: any) {
        const row = businessInfos.find((b) => matchesWhere(b, where));
        if (!row) return null;
        const out: any = { id: row.id };
        const wantsClient = (include || []).some((i: any) => i.as === 'clientAccount');
        if (wantsClient) {
          const ca = findAccount(row.clientAccountId, row.tenantId);
          out.clientAccount = ca ? { id: ca.id, userId: ca.userId ?? null } : null;
        }
        return out;
      },
    },
  } as any;
}

// ─────────────────────────────────── Tests ───────────────────────────────────

describe('Incidents — clientNotifyService (site → owning client resolution)', () => {
  let pushStub: sinon.SinonStub;
  let eventStub: sinon.SinonStub;

  beforeEach(() => {
    pushStub = sinon.stub(pushService, 'pushToClientAccounts').resolves(0 as any);
    eventStub = sinon.stub(platformEventStore, 'storePlatformEvent').resolves('evt-1' as any);
  });
  afterEach(() => sinon.restore());

  const incidentOpts = {
    eventType: 'incident.created',
    title: 'Nuevo incidente',
    body: 'Robo — Puesto Norte.',
  };

  // 1 ── Resolve via station.stationOrigin ───────────────────────────────────
  it('resolves the client through the station origin (stationOrigin)', async () => {
    const db = buildDb({
      clientAccounts: [{ id: 'ca-1', tenantId: TENANT_A, userId: 'user-1' }],
      stations: [{ id: 'st-1', tenantId: TENANT_A, postSiteId: null, stationOriginId: 'ca-1' }],
    });

    const n = await notifyClient(db, TENANT_A, { stationId: 'st-1' }, incidentOpts);

    assert.strictEqual(n, 1, 'one client recipient');
    assert.ok(pushStub.calledOnce, 'push transport invoked once');
    const [, tenantArg, clientAccountIds, userIds] = pushStub.firstCall.args;
    assert.strictEqual(tenantArg, TENANT_A);
    assert.deepStrictEqual(clientAccountIds, ['ca-1']);
    assert.deepStrictEqual(userIds, ['user-1']);
    // In-app platform event written for the linked user.
    assert.ok(eventStub.calledOnce);
    assert.strictEqual(eventStub.firstCall.args[1].recipientUserId, 'user-1');
  });

  // 2 ── Resolve via post-site businessInfo.clientAccount ─────────────────────
  it('resolves the client through the post-site businessInfo', async () => {
    const db = buildDb({
      clientAccounts: [{ id: 'ca-9', tenantId: TENANT_A, userId: 'user-9' }],
      businessInfos: [{ id: 'site-1', tenantId: TENANT_A, clientAccountId: 'ca-9' }],
    });

    const n = await notifyClient(db, TENANT_A, { postSiteId: 'site-1' }, incidentOpts);

    assert.strictEqual(n, 1);
    const [, , clientAccountIds, userIds] = pushStub.firstCall.args;
    assert.deepStrictEqual(clientAccountIds, ['ca-9']);
    assert.deepStrictEqual(userIds, ['user-9']);
  });

  // 3 ── Resolve via explicit clientAccountId ────────────────────────────────
  it('resolves the client through an explicit clientAccountId', async () => {
    const db = buildDb({
      clientAccounts: [{ id: 'ca-3', tenantId: TENANT_A, userId: 'user-3' }],
    });

    const n = await notifyClient(db, TENANT_A, { clientAccountId: 'ca-3' }, incidentOpts);

    assert.strictEqual(n, 1);
    assert.deepStrictEqual(pushStub.firstCall.args[2], ['ca-3']);
  });

  // 4 ── Station with no postSiteId still resolves through its origin ─────────
  it('resolves through the station origin even when the station has no post-site', async () => {
    const db = buildDb({
      clientAccounts: [{ id: 'ca-4', tenantId: TENANT_A, userId: 'user-4' }],
      stations: [{ id: 'st-4', tenantId: TENANT_A, postSiteId: null, stationOriginId: 'ca-4' }],
    });

    const n = await notifyClient(db, TENANT_A, { stationId: 'st-4' }, incidentOpts);
    assert.strictEqual(n, 1);
    assert.deepStrictEqual(pushStub.firstCall.args[2], ['ca-4']);
  });

  // 5 ── Station.postSiteId backfill → site client gets notified ─────────────
  it('backfills postSiteId from the station and resolves the site client', async () => {
    const db = buildDb({
      // Station has NO origin, but DOES point at a post-site whose client we want.
      clientAccounts: [{ id: 'ca-site', tenantId: TENANT_A, userId: 'user-site' }],
      stations: [{ id: 'st-5', tenantId: TENANT_A, postSiteId: 'site-5', stationOriginId: null }],
      businessInfos: [{ id: 'site-5', tenantId: TENANT_A, clientAccountId: 'ca-site' }],
    });

    const n = await notifyClient(db, TENANT_A, { stationId: 'st-5' }, incidentOpts);

    assert.strictEqual(n, 1, 'site client resolved via backfilled postSiteId');
    assert.deepStrictEqual(pushStub.firstCall.args[2], ['ca-site']);
    assert.deepStrictEqual(pushStub.firstCall.args[3], ['user-site']);
  });

  // 6 ── De-dupe when station origin === site client ─────────────────────────
  it('de-dupes when the station origin and the post-site client are the same account', async () => {
    const db = buildDb({
      clientAccounts: [{ id: 'ca-dup', tenantId: TENANT_A, userId: 'user-dup' }],
      stations: [{ id: 'st-6', tenantId: TENANT_A, postSiteId: 'site-6', stationOriginId: 'ca-dup' }],
      businessInfos: [{ id: 'site-6', tenantId: TENANT_A, clientAccountId: 'ca-dup' }],
    });

    const n = await notifyClient(db, TENANT_A, { stationId: 'st-6' }, incidentOpts);

    assert.strictEqual(n, 1, 'duplicate account counted once');
    assert.deepStrictEqual(pushStub.firstCall.args[2], ['ca-dup']);
    assert.deepStrictEqual(pushStub.firstCall.args[3], ['user-dup']);
    // Exactly one in-app event (not two) for the single distinct user.
    assert.strictEqual(eventStub.callCount, 1);
  });

  // 7 ── Union of distinct clients (origin + site differ) ────────────────────
  it('unions distinct clients when the station origin and site client differ', async () => {
    const db = buildDb({
      clientAccounts: [
        { id: 'ca-origin', tenantId: TENANT_A, userId: 'user-origin' },
        { id: 'ca-site2', tenantId: TENANT_A, userId: 'user-site2' },
      ],
      stations: [{ id: 'st-7', tenantId: TENANT_A, postSiteId: 'site-7', stationOriginId: 'ca-origin' }],
      businessInfos: [{ id: 'site-7', tenantId: TENANT_A, clientAccountId: 'ca-site2' }],
    });

    const n = await notifyClient(db, TENANT_A, { stationId: 'st-7' }, incidentOpts);

    assert.strictEqual(n, 2, 'two distinct client accounts');
    const accIds = [...pushStub.firstCall.args[2]].sort();
    const userIds = [...pushStub.firstCall.args[3]].sort();
    assert.deepStrictEqual(accIds, ['ca-origin', 'ca-site2']);
    assert.deepStrictEqual(userIds, ['user-origin', 'user-site2']);
    // One in-app platform event per distinct user.
    assert.strictEqual(eventStub.callCount, 2);
  });

  // 8 ── No linked client → 0 recipients, push never attempted ───────────────
  it('returns 0 and never pushes when the site has no linked client', async () => {
    const db = buildDb({
      stations: [{ id: 'st-8', tenantId: TENANT_A, postSiteId: 'site-8', stationOriginId: null }],
      businessInfos: [{ id: 'site-8', tenantId: TENANT_A, clientAccountId: null }],
    });

    const n = await notifyClient(db, TENANT_A, { stationId: 'st-8' }, incidentOpts);

    assert.strictEqual(n, 0);
    assert.ok(pushStub.notCalled, 'no push when there is no recipient');
    assert.ok(eventStub.notCalled);
  });

  // 9 ── Tenant isolation — other-tenant client must NOT be matched ───────────
  it('does NOT match a client account that belongs to another tenant', async () => {
    const db = buildDb({
      // The account exists, but under TENANT_B; the station lives in TENANT_A.
      clientAccounts: [{ id: 'ca-foreign', tenantId: TENANT_B, userId: 'user-foreign' }],
      stations: [{ id: 'st-9', tenantId: TENANT_A, postSiteId: null, stationOriginId: 'ca-foreign' }],
    });

    const n = await notifyClient(db, TENANT_A, { stationId: 'st-9' }, incidentOpts);

    assert.strictEqual(n, 0, 'cross-tenant account must not leak');
    assert.ok(pushStub.notCalled);
  });

  // 10 ── Missing tenantId short-circuits ────────────────────────────────────
  it('short-circuits to 0 when tenantId is missing', async () => {
    const db = buildDb({
      clientAccounts: [{ id: 'ca-x', tenantId: TENANT_A, userId: 'user-x' }],
    });

    const n = await notifyClient(db, '' as any, { clientAccountId: 'ca-x' }, incidentOpts);

    assert.strictEqual(n, 0);
    assert.ok(pushStub.notCalled);
  });

  // 11 ── Push payload carries eventType as data.type + title/body/image ──────
  it('builds the push payload with eventType under data.type plus title/body/image', async () => {
    const db = buildDb({
      clientAccounts: [{ id: 'ca-p', tenantId: TENANT_A, userId: 'user-p' }],
    });

    await notifyClient(db, TENANT_A, { clientAccountId: 'ca-p' }, {
      eventType: 'incident.created',
      title: '🚨 Alerta de pánico',
      body: 'SOS — Puesto Sur.',
      image: 'https://cdn/x.jpg',
      data: { incidentId: 'inc-1', priority: 'critical' },
      sourceEntityType: 'incident',
      sourceEntityId: 'inc-1',
    });

    const payload = pushStub.firstCall.args[4];
    assert.strictEqual(payload.title, '🚨 Alerta de pánico');
    assert.strictEqual(payload.body, 'SOS — Puesto Sur.');
    assert.strictEqual(payload.image, 'https://cdn/x.jpg');
    assert.strictEqual(payload.data.type, 'incident.created', 'eventType folded into data.type');
    assert.strictEqual(payload.data.incidentId, 'inc-1');
    assert.strictEqual(payload.data.priority, 'critical');
    // In-app event preserves source entity linkage.
    const evt = eventStub.firstCall.args[1];
    assert.strictEqual(evt.sourceEntityType, 'incident');
    assert.strictEqual(evt.sourceEntityId, 'inc-1');
    assert.strictEqual(evt.eventType, 'incident.created');
  });

  // 12 ── clientAccount with no userId still pushes by accountId ──────────────
  it('still pushes by clientAccountId when the account has no linked userId', async () => {
    const db = buildDb({
      clientAccounts: [{ id: 'ca-nouser', tenantId: TENANT_A, userId: null }],
      businessInfos: [{ id: 'site-12', tenantId: TENANT_A, clientAccountId: 'ca-nouser' }],
    });

    const n = await notifyClient(db, TENANT_A, { postSiteId: 'site-12' }, incidentOpts);

    assert.strictEqual(n, 1, 'recipient count falls back to clientAccountIds length');
    assert.deepStrictEqual(pushStub.firstCall.args[2], ['ca-nouser']);
    assert.deepStrictEqual(pushStub.firstCall.args[3], [], 'no user ids');
    // No user id → no in-app platform event written.
    assert.ok(eventStub.notCalled);
  });

  // 13 ── Never throws even if the push transport rejects ─────────────────────
  it('never throws even when the push transport rejects', async () => {
    pushStub.rejects(new Error('FCM down'));
    const db = buildDb({
      clientAccounts: [{ id: 'ca-e', tenantId: TENANT_A, userId: 'user-e' }],
    });

    // Should resolve (not reject) — fire-and-forget contract.
    const n = await notifyClient(db, TENANT_A, { clientAccountId: 'ca-e' }, incidentOpts);
    assert.strictEqual(n, 1, 'still reports the resolved recipient count');
  });
});
