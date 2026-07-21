/**
 * op-turnos · Shift PASSDOWN reception & reading (relevo al siguiente vigilante).
 *
 * Exercises the REAL getIncomingForGuard / findPassdownById / listPassdowns
 * (src/services/shiftPassdownService) against the fake db:
 *   - the incoming guard picks up the latest OPEN handover left at their post
 *     (within the 12h relief window) that they did NOT leave themselves
 *   - markReceived transitions open → received and stamps the receiver
 *   - station scoping (never picks up another post's handover) + tenant scoping
 *   - supervisor handovers are tenant-wide (no station match required)
 *   - list filters by station/status + paginates + is tenant-scoped
 */
import assert from 'assert';
import sinon from 'sinon';

import {
  getIncomingForGuard,
  findPassdownById,
  listPassdowns,
} from '../../../src/services/shiftPassdownService';
import FileRepository from '../../../src/database/repositories/fileRepository';
import { buildDb, makeRow, TENANT, OTHER_TENANT } from './helpers';

const HOURS_AGO = (h: number) => new Date(Date.now() - h * 3.6e6);

function seedPassdown(over: any = {}) {
  return {
    id: over.id || 'pd-1',
    tenantId: TENANT,
    channel: 'guard',
    stationId: 'st-1',
    stationName: 'Puesto Norte',
    postSiteId: 'ps-1',
    outgoingGuardUserId: 'u-out',
    outgoingGuardName: 'Saliente',
    status: 'open',
    instructionCount: 0,
    notes: 'novedad',
    shiftSchedule: 'Nocturno',
    shiftKind: '12h',
    createdAt: HOURS_AGO(1),
    receivedByGuardUserId: null,
    receivedAt: null,
    deletedAt: null,
    ...over,
  };
}

describe('op-turnos · getIncomingForGuard (guard relief pickup)', () => {
  beforeEach(() => {
    sinon.stub(FileRepository, 'fillDownloadUrl').resolves([] as any);
  });
  afterEach(() => sinon.restore());

  it('returns the latest open handover at the clocked-in post (hydrated with shiftLabel)', async () => {
    const db = buildDb({
      shiftPassdown: [
        seedPassdown({ id: 'pd-old', createdAt: HOURS_AGO(6), notes: 'vieja' }),
        seedPassdown({ id: 'pd-new', createdAt: HOURS_AGO(1), notes: 'reciente' }),
      ],
    });
    const incoming = await getIncomingForGuard(db, TENANT, 'u-in', { stationIds: ['st-1'] });
    assert.ok(incoming, 'incoming guard found no handover');
    assert.strictEqual(incoming.id, 'pd-new', 'must pick the most recent open handover');
    assert.strictEqual(incoming.shiftLabel, 'Turno nocturno · 12 horas', 'shiftLabel not hydrated');
  });

  it('markReceived transitions open→received and stamps the incoming guard', async () => {
    const db = buildDb({ shiftPassdown: [seedPassdown()] });
    const incoming = await getIncomingForGuard(db, TENANT, 'u-in', {
      stationIds: ['st-1'],
      markReceived: true,
      receivedByName: 'Entrante',
      receivedByShiftId: 'gs-in',
    });
    assert.ok(incoming);
    const row = db.shiftPassdown.rows[0];
    assert.strictEqual(row.status, 'received', 'status not moved to received');
    assert.strictEqual(row.receivedByGuardUserId, 'u-in', 'receiver user id not stamped');
    assert.strictEqual(row.receivedByName, 'Entrante');
    assert.strictEqual(row.receivedByShiftId, 'gs-in');
    assert.ok(row.receivedAt instanceof Date, 'receivedAt not stamped');
  });

  it('without markReceived it only READS (status stays open — a preview)', async () => {
    const db = buildDb({ shiftPassdown: [seedPassdown()] });
    await getIncomingForGuard(db, TENANT, 'u-in', { stationIds: ['st-1'] });
    assert.strictEqual(db.shiftPassdown.rows[0].status, 'open', 'a preview must not consume the handover');
  });

  it('NEVER hands a guard back their OWN passdown (outgoing != receiver)', async () => {
    const db = buildDb({ shiftPassdown: [seedPassdown({ outgoingGuardUserId: 'u-in' })] });
    const incoming = await getIncomingForGuard(db, TENANT, 'u-in', { stationIds: ['st-1'] });
    assert.strictEqual(incoming, null, 'a guard must not receive their own handover');
  });

  it('ignores a handover left at a DIFFERENT post (station scoping)', async () => {
    const db = buildDb({ shiftPassdown: [seedPassdown({ stationId: 'st-9' })] });
    const incoming = await getIncomingForGuard(db, TENANT, 'u-in', { stationIds: ['st-1'] });
    assert.strictEqual(incoming, null, 'must not pick up another post’s handover');
  });

  it('ignores a stale handover older than the 12h relief window', async () => {
    const db = buildDb({ shiftPassdown: [seedPassdown({ createdAt: HOURS_AGO(13) })] });
    const incoming = await getIncomingForGuard(db, TENANT, 'u-in', { stationIds: ['st-1'] });
    assert.strictEqual(incoming, null, 'a handover older than 12h must not be relieved');
  });

  it('ignores an already-received handover (status must be open)', async () => {
    const db = buildDb({ shiftPassdown: [seedPassdown({ status: 'received' })] });
    const incoming = await getIncomingForGuard(db, TENANT, 'u-in', { stationIds: ['st-1'] });
    assert.strictEqual(incoming, null, 'a consumed handover must not be relieved again');
  });

  it('returns null (no db lookup) when the guard clocks in with no stations', async () => {
    const db = buildDb({ shiftPassdown: [seedPassdown()] });
    const incoming = await getIncomingForGuard(db, TENANT, 'u-in', { stationIds: [] });
    assert.strictEqual(incoming, null);
    assert.strictEqual(db.shiftPassdown.calls.findOne.length, 0, 'no query should run without a station');
  });

  it('does NOT cross tenants (a foreign-tenant handover is invisible)', async () => {
    const db = buildDb({ shiftPassdown: [seedPassdown({ tenantId: OTHER_TENANT })] });
    const incoming = await getIncomingForGuard(db, TENANT, 'u-in', { stationIds: ['st-1'] });
    assert.strictEqual(incoming, null, 'tenant leak: received another tenant’s handover');
  });
});

describe('op-turnos · getIncomingForGuard (supervisor channel is tenant-wide)', () => {
  beforeEach(() => {
    sinon.stub(FileRepository, 'fillDownloadUrl').resolves([] as any);
  });
  afterEach(() => sinon.restore());

  it('matches the latest open supervisor handover WITHOUT needing a station', async () => {
    const db = buildDb({
      shiftPassdown: [
        seedPassdown({ id: 'sup-1', channel: 'supervisor', stationId: null, instructionsJson: JSON.stringify([{ taskToDo: 'x', priority: 'alta', wasItDone: false }]) }),
      ],
    });
    const incoming = await getIncomingForGuard(db, TENANT, 'u-sup-in', { channel: 'supervisor', markReceived: true });
    assert.ok(incoming, 'supervisor handover not received tenant-wide');
    assert.strictEqual(incoming.channel, 'supervisor');
    assert.deepStrictEqual(incoming.instructions?.[0]?.taskToDo, 'x', 'inline instructions not hydrated for supervisor');
    assert.strictEqual(db.shiftPassdown.rows[0].status, 'received');
  });

  it('a supervisor never receives a GUARD-channel handover (channel isolation)', async () => {
    const db = buildDb({ shiftPassdown: [seedPassdown({ channel: 'guard' })] });
    const incoming = await getIncomingForGuard(db, TENANT, 'u-sup-in', { channel: 'supervisor' });
    assert.strictEqual(incoming, null, 'channel leak: supervisor received a guard handover');
  });
});

describe('op-turnos · findPassdownById', () => {
  beforeEach(() => {
    sinon.stub(FileRepository, 'fillDownloadUrl').resolves([] as any);
  });
  afterEach(() => sinon.restore());

  it('hydrates the guard passdown with its instruction tasks (completion visible)', async () => {
    const db = buildDb({
      shiftPassdown: [seedPassdown({ id: 'pd-1', instructionCount: 1 })],
      task: [
        makeRow({ id: 'tk-1', tenantId: TENANT, passdownId: 'pd-1', taskToDo: 'Cerrar portón', priority: 'alta', status: 'approved', wasItDone: true, deletedAt: null, createdAt: HOURS_AGO(1) }),
      ],
    });
    const detail = await findPassdownById(db, TENANT, 'pd-1');
    assert.ok(detail);
    assert.strictEqual(detail.instructions.length, 1, 'instruction task not attached');
    assert.strictEqual(detail.instructions[0].taskToDo, 'Cerrar portón');
    assert.strictEqual(detail.instructions[0].wasItDone, true, 'instruction completion state lost');
    assert.strictEqual(detail.shiftLabel, 'Turno nocturno · 12 horas');
  });

  it('returns null for a passdown of ANOTHER tenant (no cross-tenant read)', async () => {
    const db = buildDb({ shiftPassdown: [seedPassdown({ tenantId: OTHER_TENANT })] });
    const detail = await findPassdownById(db, TENANT, 'pd-1');
    assert.strictEqual(detail, null, 'tenant leak on findPassdownById');
  });
});

describe('op-turnos · listPassdowns (CRM / supervisor reading)', () => {
  beforeEach(() => {
    sinon.stub(FileRepository, 'fillDownloadUrl').resolves([] as any);
  });
  afterEach(() => sinon.restore());

  function seedMany(db: any) {
    db.shiftPassdown.rows = [
      makeRow(seedPassdown({ id: 'a', stationId: 'st-1', status: 'open', createdAt: HOURS_AGO(1) })),
      makeRow(seedPassdown({ id: 'b', stationId: 'st-1', status: 'received', createdAt: HOURS_AGO(2) })),
      makeRow(seedPassdown({ id: 'c', stationId: 'st-2', status: 'open', createdAt: HOURS_AGO(3) })),
      makeRow(seedPassdown({ id: 'd', tenantId: OTHER_TENANT, stationId: 'st-1', status: 'open', createdAt: HOURS_AGO(1) })),
    ];
  }

  it('lists only this tenant’s handovers, newest first', async () => {
    const db = buildDb();
    seedMany(db);
    const { rows, count } = await listPassdowns(db, TENANT, {});
    assert.strictEqual(count, 3, 'must exclude the foreign-tenant handover');
    assert.deepStrictEqual(rows.map((r: any) => r.id), ['a', 'b', 'c'], 'not ordered newest-first');
  });

  it('filters by station', async () => {
    const db = buildDb();
    seedMany(db);
    const { rows, count } = await listPassdowns(db, TENANT, { stationId: 'st-2' });
    assert.strictEqual(count, 1);
    assert.strictEqual(rows[0].id, 'c');
  });

  it('filters by status (open only)', async () => {
    const db = buildDb();
    seedMany(db);
    const { rows } = await listPassdowns(db, TENANT, { status: 'open' });
    assert.deepStrictEqual(rows.map((r: any) => r.id).sort(), ['a', 'c']);
  });

  it('status "all" is a no-op filter (returns every status)', async () => {
    const db = buildDb();
    seedMany(db);
    const { count } = await listPassdowns(db, TENANT, { status: 'all' });
    assert.strictEqual(count, 3);
  });

  it('paginates (limit/offset) while reporting the full count', async () => {
    const db = buildDb();
    seedMany(db);
    const { rows, count } = await listPassdowns(db, TENANT, { limit: 1, offset: 1 });
    assert.strictEqual(count, 3, 'count must be the full tenant total, not the page size');
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].id, 'b', 'wrong page slice');
  });
});
