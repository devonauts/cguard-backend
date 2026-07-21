/**
 * op-turnos · Shift PASSDOWN creation (pase de turno / relevo).
 *
 * Exercises the REAL createPassdown service (src/services/shiftPassdownService)
 * against a Sequelize-shaped in-memory fake db (no MySQL, no network):
 *   - guard channel: field fidelity + each instruction becomes an approved
 *     source='passdown' post-task + notes truncation + shiftKind derivation
 *   - supervisor channel: instructions persisted inline (instructionsJson), NO tasks
 *   - photos routed through the passdownImages file relation
 *   - best-effort: platform-event / photo failures never break the handover
 *   - deriveShiftKind / passdownShiftLabel pure helpers
 *
 * Run:
 *   npx cross-env NODE_ENV=test TS_NODE_PROJECT=tsconfig.test.json mocha \
 *     -r ts-node/register 'tests/unit/op-turnos-pasedeturno/**\/*.test.ts' --exit --timeout 20000
 */
import assert from 'assert';
import sinon from 'sinon';

import {
  createPassdown,
  deriveShiftKind,
  passdownShiftLabel,
} from '../../../src/services/shiftPassdownService';
import FileRepository from '../../../src/database/repositories/fileRepository';
import { buildDb, TENANT, USER_ID } from './helpers';

// ───────────────────────── pure helpers ─────────────────────────
describe('op-turnos · deriveShiftKind', () => {
  const H = (n: number) => new Date(Date.now() + n * 3.6e6);
  const start = new Date('2026-07-14T06:00:00Z');

  it('classifies a ~24h window as "24h"', () => {
    assert.strictEqual(deriveShiftKind(start, new Date('2026-07-15T06:00:00Z')), '24h');
  });
  it('classifies a ~12h window as "12h"', () => {
    assert.strictEqual(deriveShiftKind(start, new Date('2026-07-14T18:00:00Z')), '12h');
  });
  it('classifies an 8h window as "otro"', () => {
    assert.strictEqual(deriveShiftKind(start, new Date('2026-07-14T14:00:00Z')), 'otro');
  });
  it('returns "otro" when either bound is missing', () => {
    assert.strictEqual(deriveShiftKind(null, H(12)), 'otro');
    assert.strictEqual(deriveShiftKind(start, null), 'otro');
  });
  it('returns "otro" for a non-positive window (end before start)', () => {
    assert.strictEqual(deriveShiftKind(new Date('2026-07-14T18:00:00Z'), new Date('2026-07-14T06:00:00Z')), 'otro');
  });
});

describe('op-turnos · passdownShiftLabel', () => {
  it('composes schedule + kind (nocturno · 12 horas)', () => {
    assert.strictEqual(passdownShiftLabel('Nocturno', '12h'), 'Turno nocturno · 12 horas');
  });
  it('composes diurno · 24 horas', () => {
    assert.strictEqual(passdownShiftLabel('Diurno', '24h'), 'Turno diurno · 24 horas');
  });
  it('omits the kind clause when kind is "otro"/unknown', () => {
    assert.strictEqual(passdownShiftLabel('Nocturno', 'otro'), 'Turno nocturno');
  });
  it('falls back to plain "Turno" for an unknown schedule', () => {
    assert.strictEqual(passdownShiftLabel(null, null), 'Turno');
  });
});

// ───────────────────────── guard channel ─────────────────────────
describe('op-turnos · createPassdown (guard channel)', () => {
  beforeEach(() => {
    sinon.stub(FileRepository, 'replaceRelationFiles').resolves();
  });
  afterEach(() => sinon.restore());

  const station = { id: 'st-1', stationName: 'Puesto Norte', postSiteId: 'ps-1' };
  const guardShift = {
    id: 'gs-1',
    shiftSchedule: 'Nocturno',
    scheduledStart: new Date('2026-07-14T18:00:00Z'),
    scheduledEnd: new Date('2026-07-15T06:00:00Z'), // 12h
  };

  it('persists the handover with every field + derives shiftKind from the window', async () => {
    const db = buildDb();
    const passdown = await createPassdown(db, TENANT, {
      channel: 'guard',
      station,
      guardShift,
      outgoingUserId: 'u-out',
      outgoingSecurityGuardId: 'sg-out',
      outgoingGuardName: 'Vigilante Saliente',
      notes: '  Todo tranquilo en la ronda  ',
      instructions: [{ text: 'Revisar cámara 3', priority: 'alta' }],
      currentUser: { id: USER_ID },
    });

    assert.strictEqual(db.shiftPassdown.calls.create.length, 1);
    const w = db.shiftPassdown.calls.create[0];
    assert.strictEqual(w.tenantId, TENANT);
    assert.strictEqual(w.channel, 'guard');
    assert.strictEqual(w.stationId, 'st-1');
    assert.strictEqual(w.stationName, 'Puesto Norte');
    assert.strictEqual(w.postSiteId, 'ps-1');
    assert.strictEqual(w.outgoingGuardUserId, 'u-out');
    assert.strictEqual(w.outgoingSecurityGuardId, 'sg-out');
    assert.strictEqual(w.outgoingGuardName, 'Vigilante Saliente');
    assert.strictEqual(w.guardShiftId, 'gs-1');
    assert.strictEqual(w.shiftSchedule, 'Nocturno');
    assert.strictEqual(w.shiftKind, '12h', 'shiftKind not derived from the scheduled window');
    assert.strictEqual(w.notes, 'Todo tranquilo en la ronda', 'notes not trimmed');
    assert.strictEqual(w.instructionCount, 1);
    assert.strictEqual(w.status, 'open');
    assert.strictEqual(w.instructionsJson, null, 'guard instructions must NOT be inlined');
    assert.ok(passdown && passdown.id);
  });

  it('turns EACH instruction into an approved post-task (source=passdown, linked to the passdown + station)', async () => {
    const db = buildDb();
    const p = await createPassdown(db, TENANT, {
      channel: 'guard',
      station,
      guardShift,
      outgoingUserId: 'u-out',
      instructions: [
        { text: '  Cerrar portón trasero  ', priority: 'alta' },
        { text: 'Reportar luz fundida', priority: 'zzz-bad' }, // invalid priority → media
        { text: '   ' }, // blank → filtered out
      ],
    });

    // Two valid instructions → two tasks; the blank one is dropped.
    assert.strictEqual(db.task.calls.create.length, 2);
    assert.strictEqual(db.shiftPassdown.calls.create[0].instructionCount, 2, 'instructionCount must count only non-blank instructions');

    const t0 = db.task.calls.create[0];
    assert.strictEqual(t0.tenantId, TENANT);
    assert.strictEqual(t0.taskToDo, 'Cerrar portón trasero', 'instruction text not trimmed into the task');
    assert.strictEqual(t0.taskBelongsToStationId, 'st-1');
    assert.strictEqual(t0.status, 'approved');
    assert.strictEqual(t0.source, 'passdown');
    assert.strictEqual(t0.priority, 'alta');
    assert.strictEqual(t0.wasItDone, false);
    assert.strictEqual(t0.passdownId, p.id, 'task not linked back to its passdown');
    assert.strictEqual(t0.createdById, 'u-out');
    assert.ok(t0.approvedAt, 'approved task must carry approvedAt');

    const t1 = db.task.calls.create[1];
    assert.strictEqual(t1.priority, 'media', 'an invalid priority must fall back to "media"');
  });

  it('caps notes to 4000 chars and instruction text to 300 chars', async () => {
    const db = buildDb();
    await createPassdown(db, TENANT, {
      channel: 'guard',
      station,
      guardShift,
      notes: 'z'.repeat(5000),
      instructions: [{ text: 'y'.repeat(400), priority: 'media' }],
    });
    assert.strictEqual(db.shiftPassdown.calls.create[0].notes.length, 4000, 'notes not capped to 4000');
    assert.strictEqual(db.task.calls.create[0].taskToDo.length, 300, 'instruction text not capped to 300');
  });

  it('stores "Sin novedad"-style empty notes as null (no task) when nothing is handed over', async () => {
    const db = buildDb();
    await createPassdown(db, TENANT, { channel: 'guard', station, guardShift, notes: '   ', instructions: [] });
    assert.strictEqual(db.shiftPassdown.calls.create[0].notes, null);
    assert.strictEqual(db.task.calls.create.length, 0, 'no tasks for an empty handover');
    assert.strictEqual(db.shiftPassdown.calls.create[0].instructionCount, 0);
  });

  it('routes photos through the passdownImages file relation', async () => {
    const db = buildDb();
    const photos = [{ id: 'f-1', name: 'ronda.jpg' }];
    await createPassdown(db, TENANT, { channel: 'guard', station, guardShift, photos, currentUser: { id: USER_ID } });
    const stub = FileRepository.replaceRelationFiles as sinon.SinonStub;
    const call = stub.getCalls().find((c) => c.args[0].belongsToColumn === 'passdownImages');
    assert.ok(call, 'passdownImages relation was not written');
    assert.deepStrictEqual(call!.args[1], photos);
  });

  it('is best-effort: a platform-event write failure does NOT break the handover', async () => {
    const db = buildDb();
    db.sequelize.query = async () => {
      throw new Error('events table gone');
    };
    const p = await createPassdown(db, TENANT, { channel: 'guard', station, guardShift, notes: 'ok' });
    assert.ok(p && p.id, 'handover must still be created when the awareness event fails');
    assert.strictEqual(db.shiftPassdown.calls.create.length, 1);
  });

  it('is best-effort: a photo-attach failure does NOT break the handover', async () => {
    const db = buildDb();
    (FileRepository.replaceRelationFiles as sinon.SinonStub).rejects(new Error('storage down'));
    const p = await createPassdown(db, TENANT, {
      channel: 'guard',
      station,
      guardShift,
      photos: [{ id: 'f-1' }],
    });
    assert.ok(p && p.id, 'handover must still be created when the photo attach fails');
  });

  // FIXED: a GUARD-channel passdown with instructions but NO station used to drop
  // the instruction text (no post-task without a station, and inlining was
  // supervisor-only), leaving instructionCount=N with the text unrecoverable.
  // Now, when there's no post to hang tasks on, the text is inlined into
  // instructionsJson so it survives.
  it('FIXED: guard passdown sin estación conserva el texto en instructionsJson', async () => {
    const db = buildDb();
    await createPassdown(db, TENANT, {
      channel: 'guard',
      station: null,
      guardShift,
      instructions: [{ text: 'Instrucción sin puesto', priority: 'alta' }],
    });
    const w = db.shiftPassdown.calls.create[0];
    assert.strictEqual(db.task.calls.create.length, 0, 'no post-task is created without a station');
    assert.ok(w.instructionsJson, 'sin puesto, el texto se persiste inline (no se pierde)');
    const parsed = JSON.parse(w.instructionsJson);
    assert.strictEqual(parsed[0].taskToDo, 'Instrucción sin puesto', 'el texto sobrevive');
    assert.strictEqual(w.instructionCount, 1);
  });
});

// ───────────────────────── supervisor channel ─────────────────────────
describe('op-turnos · createPassdown (supervisor channel)', () => {
  beforeEach(() => {
    sinon.stub(FileRepository, 'replaceRelationFiles').resolves();
  });
  afterEach(() => sinon.restore());

  it('inlines instructions into instructionsJson and creates NO post-tasks', async () => {
    const db = buildDb();
    await createPassdown(db, TENANT, {
      channel: 'supervisor',
      outgoingUserId: 'u-sup',
      outgoingGuardName: 'Supervisor Uno',
      shiftSchedule: 'Diurno',
      notes: 'Recorrido completo',
      instructions: [
        { text: 'Llamar al cliente A', priority: 'alta' },
        { text: 'Verificar bitácora', priority: 'bad' },
      ],
    });

    assert.strictEqual(db.task.calls.create.length, 0, 'supervisor handover must NOT create post-tasks');
    const w = db.shiftPassdown.calls.create[0];
    assert.strictEqual(w.channel, 'supervisor');
    assert.strictEqual(w.stationId, null);
    assert.strictEqual(w.instructionCount, 2);
    assert.ok(w.instructionsJson, 'supervisor instructions must be inlined');
    const parsed = JSON.parse(w.instructionsJson);
    assert.strictEqual(parsed.length, 2);
    assert.strictEqual(parsed[0].taskToDo, 'Llamar al cliente A');
    assert.strictEqual(parsed[0].priority, 'alta');
    assert.strictEqual(parsed[0].wasItDone, false);
    assert.strictEqual(parsed[1].priority, 'media', 'invalid priority normalised to media in the inline blob');
  });

  it('leaves instructionsJson null when a supervisor hands over with no instructions', async () => {
    const db = buildDb();
    await createPassdown(db, TENANT, { channel: 'supervisor', notes: 'Sin novedad', instructions: [] });
    assert.strictEqual(db.shiftPassdown.calls.create[0].instructionsJson, null);
    assert.strictEqual(db.shiftPassdown.calls.create[0].instructionCount, 0);
  });
});
