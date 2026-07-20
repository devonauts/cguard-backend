/**
 * Unit tests — COORDINACIÓN OPERATIVA + TIMEZONE del Programador.
 *
 * El motor de turnos vive en src/services/shiftGenerationService.ts. La época de
 * rotación es FIJA (2024-01-01 UTC) y "hoy" SIEMPRE se calcula en la zona horaria
 * del tenant (ymd(now, tenantTz)) — nunca en UTC. Esta suite fija tres conductas
 * operativas que el usuario exige:
 *
 *   (a) TZ DEL TENANT MANDA — un assignment creado a las 20:00 hora Ecuador
 *       (= 01:00 UTC del día siguiente) empieza HOY, no mañana. Si el motor
 *       floreara "hoy" en UTC, el turno "se pondría para mañana" (bug histórico).
 *       Replica el freeze de reloj de schedule-shifts/genStartTz.test.ts.
 *
 *   (b) CUSTOM MULTI-BLOQUE — una ventana 06:00–22:00 partida en bloques de 8h
 *       produce DOS fijos, cada uno con SUS horas de bloque (06–14 y 14–22),
 *       escalonados por dayShifts para que sus DESCANSOS NO SE PISEN (a lo sumo
 *       un bloque libre por día ⇒ un solo sacafranco encadena). Se afirma tanto
 *       en el camino real de auto-config (autoConfigureStationPositions) como en
 *       el motor puro (computeShiftsForAssignment) con off0/off2 del enunciado.
 *
 *   (c) RE-ASIGNAR UN PUESTO REEMPLAZA AL OCUPANTE ANTERIOR — al generar los
 *       turnos de una nueva asignación sobre el mismo positionId, los turnos
 *       FUTUROS del ocupante viejo (borrados por positionId) y cualquier turno
 *       viejo de la misma asignación (borrados por guardAssignmentId) desaparecen;
 *       los pasados se conservan (la ventana arranca en "hoy").
 *
 * Todo corre contra una fake-db en memoria (Sequelize-shaped, Op-aware) + sinon
 * fake timers. Sin MySQL, sin red. Patrón espejo de
 * tests/unit/programador/optimizeNoDouble.test.ts y schedule-shifts/genStartTz.test.ts.
 *
 * Run:
 *   npx cross-env NODE_ENV=test TS_NODE_PROJECT=tsconfig.test.json \
 *     mocha -r ts-node/register \
 *     'tests/unit/programador/coordinacionTz.test.ts' --exit --timeout 15000
 */

import assert from 'assert';
import sinon from 'sinon';
import { Op } from 'sequelize';

import {
  computeShiftsForAssignment,
  generateShiftsForAssignment,
  ComputedShift,
} from '../../../src/services/shiftGenerationService';
import { autoConfigureStationPositions } from '../../../src/services/stationAutoConfigService';

const TENANT = 'aaaaaaaa-0000-0000-0000-0000000000aa';
const USER_ID = 'user-admin-1';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers de tiempo/tz.
// ─────────────────────────────────────────────────────────────────────────────
/** Fecha de calendario local (YYYY-MM-DD) de un instante en una tz. */
function dateInTz(d: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}
/** HH:mm local de un instante en una tz. */
function hhmmInTz(d: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
}

// ─────────────────────────────────────────────────────────────────────────────
// (a) + (b-motor): fake db mínima que sólo toca computeShiftsForAssignment.
// ─────────────────────────────────────────────────────────────────────────────
function simpleDb(opts: {
  tz: string;
  rotationStyleId: string | null;
  rot?: any;
  positionsById?: Record<string, any>;
}) {
  return {
    tenant: { findByPk: async () => ({ timezone: opts.tz }) },
    station: { findByPk: async () => ({ postSiteId: 'ps-1', rotationStyleId: opts.rotationStyleId }) },
    rotationStyle: { findByPk: async () => opts.rot ?? null },
    stationPosition: { findByPk: async (id: any) => (opts.positionsById ? opts.positionsById[String(id)] || null : null) },
  } as any;
}

// ═════════════════════════════════════════════════════════════════════════════
// (a) "HOY" = tenant-tz, nunca UTC.
// ═════════════════════════════════════════════════════════════════════════════
describe('programador · (a) "hoy" se calcula en la tz del tenant, no en UTC', () => {
  const TZ = 'America/Guayaquil'; // UTC-5, sin DST
  let clock: sinon.SinonFakeTimers;

  // 2026-07-17T01:00Z  ==  2026-07-16 20:00 en Guayaquil.
  // UTC ya está en el día 17; el tenant sigue en el 16 (las 20:00).
  beforeEach(() => { clock = sinon.useFakeTimers(new Date('2026-07-17T01:00:00Z').getTime()); });
  afterEach(() => clock.restore());

  it('el escenario es real: a las 20:00 Ecuador el día UTC (17) ≠ el día del tenant (16)', () => {
    const now = new Date();
    assert.strictEqual(dateInTz(now, 'UTC'), '2026-07-17', 'UTC ya rodó al 17');
    assert.strictEqual(dateInTz(now, TZ), '2026-07-16', 'el tenant sigue en el 16 (20:00)');
    assert.strictEqual(hhmmInTz(now, TZ), '20:00', 'son las 20:00 en Ecuador');
  });

  it('un assignment adhoc "para hoy" (2026-07-16) genera su turno HOY (16), no mañana (17)', async () => {
    const db = simpleDb({ tz: TZ, rotationStyleId: null });
    const assignment: any = {
      id: 'a-1',
      guardId: 'g-1',
      stationId: 'st-1',
      positionId: null,
      rotationStyleId: null,
      startDate: '2026-07-16', // el día de pared del operador
      platoonOffset: 0,
      isRelief: false,
      kind: 'adhoc',
      startTime: '07:00',
      endTime: '19:00',
    };

    const shifts = await computeShiftsForAssignment(db, assignment, TENANT);

    assert.ok(shifts.length >= 1, 'debe generar al menos un turno');
    const first = shifts[0];
    assert.strictEqual(
      dateInTz(first.startTime, TZ), '2026-07-16',
      `el primer turno debe caer HOY (2026-07-16) en la tz del tenant, no ${dateInTz(first.startTime, TZ)}`,
    );
    // Y jamás debe empezar el 17 (el día UTC).
    assert.notStrictEqual(dateInTz(first.startTime, TZ), '2026-07-17', 'no debe "ponerse para mañana"');
    assert.strictEqual(hhmmInTz(first.startTime, TZ), '07:00', 'arranca 07:00 hora local');
  });

  it('un assignment de rotación (fijo) "para hoy" también arranca HOY (16) en tz del tenant', async () => {
    // Fijo 12h-día, rotación 8-2 (dayShifts=8): el día 0 del ciclo depende del
    // offset, pero pase lo que pase el primer turno NO puede caer antes de "hoy"
    // ni saltar al día UTC. Elegimos el offset que hace que HOY sea día de trabajo.
    const TZ_UTC_EPOCH = Date.UTC(2024, 0, 1);
    const dseToday = Math.floor((Date.parse('2026-07-16T00:00:00Z') - TZ_UTC_EPOCH) / 86400000);
    const rot = { dayShifts: 8, nightShifts: 0, restDays: 2 };
    const offsetToday = ((dseToday % 10) + 10) % 10; // hace que dse(hoy) sea posición 0 ⇒ trabaja
    const db = simpleDb({
      tz: TZ,
      rotationStyleId: 'rot-1',
      rot,
      positionsById: { 'pos-1': { type: 'fijo', startTime: '07:00', endTime: '19:00' } },
    });
    const assignment: any = {
      id: 'a-2', guardId: 'g-2', stationId: 'st-1', positionId: 'pos-1', rotationStyleId: 'rot-1',
      startDate: '2026-07-16', endDate: '2026-07-16', platoonOffset: offsetToday,
      isRelief: false, kind: 'rotation',
    };
    const shifts = await computeShiftsForAssignment(db, assignment, TENANT);
    assert.ok(shifts.length >= 1, 'el fijo debe trabajar hoy con este offset');
    assert.strictEqual(dateInTz(shifts[0].startTime, TZ), '2026-07-16', 'el fijo arranca HOY en tz del tenant');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// (b) CUSTOM MULTI-BLOQUE — 06:00–22:00 en bloques de 8h ⇒ 2 fijos escalonados.
// ═════════════════════════════════════════════════════════════════════════════
describe('programador · (b) custom multi-bloque 06:00–22:00 / 8h ⇒ 2 fijos, descansos disjuntos', () => {
  const TZ = 'UTC'; // día de calendario == día UTC ⇒ bucketing exacto
  const EPOCH_MS = Date.UTC(2024, 0, 1);
  const DAY_MS = 86400000;
  let clock: sinon.SinonFakeTimers;
  beforeEach(() => { clock = sinon.useFakeTimers(new Date('2026-01-01T12:00:00Z').getTime()); });
  afterEach(() => clock.restore());

  // ── (b.1) Camino real de auto-config: parte la ventana en 2 bloques ──────────
  it('autoConfigureStationPositions crea 2 fijos con horas 06–14 y 14–22, escalonados por dayShifts', async () => {
    const db = buildFullDb(TZ);
    // 8-2 y 4-4-2 deben existir para que los resolvers (custom ⇒ 8-2, SF ⇒ 4-4-2) encuentren estilo.
    db.rotationStyle.rows.push(makeRow({ id: 'rot-82', name: '8-2', isSystem: true, dayShifts: 8, nightShifts: 0, restDays: 2 }));
    db.rotationStyle.rows.push(makeRow({ id: 'rot-442', name: '4-4-2', isSystem: true, dayShifts: 4, nightShifts: 4, restDays: 2 }));
    db.station.rows.push(makeRow({
      id: 'st-c', tenantId: TENANT, stationName: 'Custom', scheduleType: 'custom',
      rotationStyleId: null, postSiteId: 'ps-c', deletedAt: null,
      startingTimeInDay: '06:00', finishTimeInDay: '22:00',
    }));

    await autoConfigureStationPositions(db, {
      stationId: 'st-c', tenantId: TENANT, userId: USER_ID,
      scheduleType: 'custom', rotationStyleId: 'rot-82',
      // runSacafrancoOptimize:false ⇒ omite el pase tenant-wide (usa setImmediate,
      // que los fake timers de sinon congelan). Sólo probamos la derivación de
      // posiciones del camino de config, que es determinista sin el optimize.
      runSacafrancoOptimize: false,
      data: { startTime: '06:00', endTime: '22:00', blockHours: 8, restCoverage: 'sacafranco' },
    });

    const fijos = db.stationPosition.rows
      .filter((p: any) => p.stationId === 'st-c' && p.type === 'fijo')
      .sort((a: any, b: any) => (a.sortOrder || 0) - (b.sortOrder || 0));

    assert.strictEqual(fijos.length, 2, 'la ventana 16h / 8h se parte en exactamente 2 bloques ⇒ 2 fijos');
    // Cada fijo lleva SUS propias horas de bloque.
    assert.strictEqual(fijos[0].startTime, '06:00');
    assert.strictEqual(fijos[0].endTime, '14:00');
    assert.strictEqual(fijos[1].startTime, '14:00');
    assert.strictEqual(fijos[1].endTime, '22:00');

    // Escalonados por dayShifts (=8) módulo el ciclo (=10): offB − offA ≡ −8 ≡ 2.
    const cycle = 10;
    const offA = ((fijos[0].platoonOffset % cycle) + cycle) % cycle;
    const offB = ((fijos[1].platoonOffset % cycle) + cycle) % cycle;
    assert.strictEqual(((offA - offB) % cycle + cycle) % cycle, 8, 'los dos bloques están escalonados por dayShifts');

    // Sus descansos (2 residuos por ciclo cada uno) deben ser DISJUNTOS.
    const restResidues = (off: number) => new Set([(off + 8) % cycle, (off + 9) % cycle]);
    const rA = restResidues(offA);
    const rB = restResidues(offB);
    for (const r of rA) assert.ok(!rB.has(r), `descansos se pisan en residuo ${r} (offA=${offA} offB=${offB})`);
  });

  // ── (b.2) Motor puro con los offsets del enunciado (06–14 off0, 14–22 off2) ──
  it('computeShiftsForAssignment: fijo 06–14@off0 y fijo 14–22@off2 — horas por bloque y descansos que no se pisan', async () => {
    const rot = { dayShifts: 8, nightShifts: 0, restDays: 2 };
    const positionsById = {
      'posA': { type: 'fijo', startTime: '06:00', endTime: '14:00' },
      'posB': { type: 'fijo', startTime: '14:00', endTime: '22:00' },
    };
    const START = '2026-01-01';
    const K = 3, C = 10, W = K * C; // super-ciclo de 30 días
    const END = new Date(Date.parse(`${START}T00:00:00Z`) + (W - 1) * DAY_MS).toISOString().slice(0, 10);

    async function runFijo(posId: string, offset: number): Promise<ComputedShift[]> {
      const db = simpleDb({ tz: TZ, rotationStyleId: 'rot-1', rot, positionsById });
      const assignment: any = {
        id: `a-${posId}`, guardId: `g-${posId}`, stationId: 'st-c', positionId: posId, rotationStyleId: 'rot-1',
        startDate: START, endDate: END, platoonOffset: offset, isRelief: false, kind: 'rotation',
      };
      return computeShiftsForAssignment(db, assignment, TENANT);
    }

    const shiftsA = await runFijo('posA', 0); // bloque 06–14, offset 0
    const shiftsB = await runFijo('posB', 2); // bloque 14–22, offset 2

    // Horas por bloque: A siempre 06:00–14:00, B siempre 14:00–22:00.
    for (const s of shiftsA) {
      assert.strictEqual(hhmmInTz(s.startTime, TZ), '06:00', 'fijo A arranca 06:00');
      assert.strictEqual(hhmmInTz(s.endTime, TZ), '14:00', 'fijo A termina 14:00');
    }
    for (const s of shiftsB) {
      assert.strictEqual(hhmmInTz(s.startTime, TZ), '14:00', 'fijo B arranca 14:00');
      assert.strictEqual(hhmmInTz(s.endTime, TZ), '22:00', 'fijo B termina 22:00');
    }

    // I1 (LIBRES): cada uno trabaja K·(D+N)=24 y descansa K·L=6 en el super-ciclo.
    assert.strictEqual(shiftsA.length, K * (rot.dayShifts + rot.nightShifts), 'A: 24 días trabajados en 30');
    assert.strictEqual(shiftsB.length, K * (rot.dayShifts + rot.nightShifts), 'B: 24 días trabajados en 30');

    // Descansos que NO se pisan: no existe día de calendario donde AMBOS descansen.
    const allDays: string[] = [];
    for (let i = 0; i < W; i++) allDays.push(new Date(Date.parse(`${START}T00:00:00Z`) + i * DAY_MS).toISOString().slice(0, 10));
    const workedA = new Set(shiftsA.map((s) => dateInTz(s.startTime, TZ)));
    const workedB = new Set(shiftsB.map((s) => dateInTz(s.startTime, TZ)));
    const restA = allDays.filter((d) => !workedA.has(d));
    const restB = allDays.filter((d) => !workedB.has(d));
    assert.strictEqual(restA.length, K * rot.restDays, 'A descansa 6 días');
    assert.strictEqual(restB.length, K * rot.restDays, 'B descansa 6 días');
    const restBset = new Set(restB);
    for (const d of restA) {
      assert.ok(!restBset.has(d), `día ${d}: ambos fijos descansan — los descansos se pisan (rompe el escalonado)`);
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// (c) RE-ASIGNAR UN PUESTO REEMPLAZA AL OCUPANTE ANTERIOR.
// ═════════════════════════════════════════════════════════════════════════════
describe('programador · (c) re-asignar un puesto borra los turnos del ocupante anterior', () => {
  const TZ = 'UTC';
  let clock: sinon.SinonFakeTimers;
  beforeEach(() => { clock = sinon.useFakeTimers(new Date('2026-07-01T12:00:00Z').getTime()); });
  afterEach(() => clock.restore());

  function seedStationAndRot(db: any) {
    db.rotationStyle.rows.push(makeRow({ id: 'rot-82', name: '8-2', isSystem: true, dayShifts: 8, nightShifts: 0, restDays: 2 }));
    db.station.rows.push(makeRow({
      id: 'st-1', tenantId: TENANT, stationName: 'st-1', rotationStyleId: 'rot-82',
      scheduleType: '12h-day', postSiteId: 'ps-1', deletedAt: null,
    }));
    db.stationPosition.rows.push(makeRow({
      id: 'pos-1', tenantId: TENANT, stationId: 'st-1', type: 'fijo',
      startTime: '07:00', endTime: '19:00', guardsNeeded: 1, sortOrder: 0, platoonOffset: 0, deletedAt: null,
    }));
  }

  it('un nuevo vigilante toma pos-1: los turnos FUTUROS del viejo (por positionId) se borran; los PASADOS se conservan', async () => {
    const db = buildFullDb(TZ);
    seedStationAndRot(db);

    // Ocupante viejo con turnos pasado (conservar) y futuro (borrar).
    db.shift.rows.push(makeRow({
      id: 'sh-old-past', tenantId: TENANT, stationId: 'st-1', positionId: 'pos-1', guardId: 'g-old',
      guardAssignmentId: 'ga-old', startTime: new Date('2026-06-15T07:00:00Z'), endTime: new Date('2026-06-15T19:00:00Z'),
    }));
    db.shift.rows.push(makeRow({
      id: 'sh-old-future', tenantId: TENANT, stationId: 'st-1', positionId: 'pos-1', guardId: 'g-old',
      guardAssignmentId: 'ga-old', startTime: new Date('2026-07-10T07:00:00Z'), endTime: new Date('2026-07-10T19:00:00Z'),
    }));

    // Nueva asignación: mismo positionId, distinto guard/assignment.
    const gaNew: any = {
      id: 'ga-new', guardId: 'g-new', stationId: 'st-1', positionId: 'pos-1', rotationStyleId: 'rot-82',
      startDate: '2026-06-01', endDate: '2026-07-20', platoonOffset: 0, isRelief: false, kind: 'rotation', status: 'active',
    };
    db.guardAssignment.rows.push(makeRow({ ...gaNew, deletedAt: null }));

    await generateShiftsForAssignment(db, gaNew, TENANT, USER_ID);

    const rows = db.shift.rows;
    // El turno FUTURO del viejo desapareció (borrado por la cláusula positionId).
    assert.ok(!rows.some((r: any) => r.id === 'sh-old-future'), 'el turno futuro del ocupante viejo debe borrarse');
    // Ningún turno futuro (>= hoy) del vigilante viejo sobrevive.
    const oldFuture = rows.filter((r: any) => r.guardId === 'g-old' && new Date(r.startTime) >= new Date('2026-07-01T00:00:00Z'));
    assert.strictEqual(oldFuture.length, 0, 'no debe quedar ningún turno futuro del ocupante anterior');
    // El turno PASADO del viejo se conserva (la ventana arranca en "hoy").
    assert.ok(rows.some((r: any) => r.id === 'sh-old-past'), 'los turnos pasados del ocupante viejo se conservan');
    // El nuevo ocupante tiene turnos en pos-1.
    const newRows = rows.filter((r: any) => r.guardId === 'g-new' && String(r.positionId) === 'pos-1');
    assert.ok(newRows.length > 0, 'el nuevo ocupante debe tener turnos generados en pos-1');
  });

  it('regenerar la MISMA asignación borra sus turnos viejos por guardAssignmentId (incluso positionId nulo legacy)', async () => {
    const db = buildFullDb(TZ);
    seedStationAndRot(db);

    // Turno legacy de ga-new con positionId NULO (no cae por la cláusula positionId,
    // sí por la de guardAssignmentId).
    db.shift.rows.push(makeRow({
      id: 'sh-legacy', tenantId: TENANT, stationId: 'st-1', positionId: null, guardId: 'g-new',
      guardAssignmentId: 'ga-new', startTime: new Date('2026-07-10T03:00:00Z'), endTime: new Date('2026-07-10T09:00:00Z'),
    }));

    const gaNew: any = {
      id: 'ga-new', guardId: 'g-new', stationId: 'st-1', positionId: 'pos-1', rotationStyleId: 'rot-82',
      startDate: '2026-06-01', endDate: '2026-07-20', platoonOffset: 0, isRelief: false, kind: 'rotation', status: 'active',
    };
    db.guardAssignment.rows.push(makeRow({ ...gaNew, deletedAt: null }));

    await generateShiftsForAssignment(db, gaNew, TENANT, USER_ID);

    const rows = db.shift.rows;
    assert.ok(!rows.some((r: any) => r.id === 'sh-legacy'), 'el turno legacy de la misma asignación debe borrarse por guardAssignmentId');
    // Ya no queda ningún turno de ga-new con positionId nulo (todos los frescos llevan pos-1).
    const staleNull = rows.filter((r: any) => String(r.guardAssignmentId) === 'ga-new' && r.positionId == null);
    assert.strictEqual(staleNull.length, 0, 'no debe sobrevivir un turno legacy con positionId nulo');
    assert.ok(rows.some((r: any) => String(r.guardAssignmentId) === 'ga-new' && String(r.positionId) === 'pos-1'), 'los turnos frescos llevan pos-1');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Fake db Sequelize-shaped, Op-aware (patrón de optimizeNoDouble.test.ts).
// ═════════════════════════════════════════════════════════════════════════════
function toCmp(v: any): number | string {
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'string' && /\d{4}-\d\d-\d\dT/.test(v)) return new Date(v).getTime();
  return v;
}
function matchField(rowVal: any, cond: any): boolean {
  if (cond === null) return rowVal === null || rowVal === undefined;
  if (Array.isArray(cond)) return cond.map(String).includes(String(rowVal));
  if (cond && typeof cond === 'object' && !(cond instanceof Date)) {
    for (const sym of Object.getOwnPropertySymbols(cond)) {
      const v = (cond as any)[sym];
      if (sym === Op.ne) { if (v === null ? (rowVal === null || rowVal === undefined) : String(rowVal) === String(v)) return false; }
      else if (sym === Op.in) { if (!(v as any[]).map(String).includes(String(rowVal))) return false; }
      else if (sym === Op.gte) { if (!(toCmp(rowVal) >= toCmp(v))) return false; }
      else if (sym === Op.lte) { if (!(toCmp(rowVal) <= toCmp(v))) return false; }
      else if (sym === Op.gt) { if (!(toCmp(rowVal) > toCmp(v))) return false; }
      else if (sym === Op.lt) { if (!(toCmp(rowVal) < toCmp(v))) return false; }
    }
    for (const k of Object.keys(cond)) { if (String(rowVal) !== String((cond as any)[k])) return false; }
    return true;
  }
  return String(rowVal) === String(cond);
}
function matchWhere(row: any, where: any): boolean {
  if (!where) return true;
  for (const key of Object.keys(where)) {
    if (!matchField(row[key], where[key])) return false;
  }
  for (const sym of Object.getOwnPropertySymbols(where)) {
    const subs = (where as any)[sym] as any[];
    if (sym === Op.or) { if (!subs.some((w) => matchWhere(row, w))) return false; }
    else if (sym === Op.and) { if (!subs.every((w) => matchWhere(row, w))) return false; }
  }
  return true;
}
function applyOrder(rows: any[], order?: any[]): any[] {
  if (!order || !order.length) return rows;
  return rows.slice().sort((a, b) => {
    for (const o of order) {
      const field = Array.isArray(o) ? o[0] : o;
      const dir = Array.isArray(o) && String(o[1]).toUpperCase() === 'DESC' ? -1 : 1;
      const av = toCmp(a[field]); const bv = toCmp(b[field]);
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
    }
    return 0;
  });
}
function makeRow(data: any) {
  const row: any = {
    ...data,
    async update(patch: any) {
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined) continue;
        row[k] = v;
      }
      return row;
    },
    get() { const { update, get, ...rest } = row; void update; void get; return { ...rest }; },
  };
  return row;
}
function makeModel(name: string) {
  let seq = 0;
  const model: any = {
    name,
    rows: [] as any[],
    calls: { create: [] as any[], update: [] as any[], destroy: [] as any[], bulkCreate: [] as any[] },
    async create(data: any) {
      const row = makeRow({ id: data.id || `${name}-${++seq}`, ...data });
      model.calls.create.push({ ...data });
      model.rows.push(row);
      return row;
    },
    async bulkCreate(rows: any[]) {
      model.calls.bulkCreate.push(rows.map((r) => ({ ...r })));
      return rows.map((r) => {
        const row = makeRow({ id: r.id || `${name}-${++seq}`, ...r });
        model.rows.push(row);
        return row;
      });
    },
    async findAll(q: any = {}) {
      let out = model.rows.filter((r: any) => matchWhere(r, q.where));
      if (q.group) {
        const keys: string[] = Array.isArray(q.group) ? q.group : [q.group];
        const seen = new Set<string>();
        out = out.filter((r: any) => {
          const k = keys.map((g) => String(r[g])).join('|');
          if (seen.has(k)) return false;
          seen.add(k); return true;
        });
      }
      return applyOrder(out, q.order);
    },
    async findOne(q: any = {}) {
      const out = applyOrder(model.rows.filter((r: any) => matchWhere(r, q.where)), q.order);
      return out[0] || null;
    },
    async findByPk(id: any) {
      return model.rows.find((r: any) => String(r.id) === String(id)) || null;
    },
    async count(q: any = {}) {
      return model.rows.filter((r: any) => matchWhere(r, q.where)).length;
    },
    async update(patch: any, q: any = {}) {
      model.calls.update.push({ patch: { ...patch }, where: q.where || {} });
      const victims = model.rows.filter((r: any) => matchWhere(r, q.where));
      for (const r of victims) await r.update(patch);
      return [victims.length];
    },
    async destroy(q: any = {}) {
      model.calls.destroy.push(q.where || {});
      const before = model.rows.length;
      const survivors = model.rows.filter((r: any) => !matchWhere(r, q.where));
      model.rows.length = 0;
      model.rows.push(...survivors);
      return before - survivors.length;
    },
  };
  return model;
}
function buildFullDb(tz: string) {
  const db: any = {
    Sequelize: { Op },
    sequelize: { async transaction(cb: any) { return cb({ id: 'tx' }); } },
    tenant: makeModel('tenant'),
    station: makeModel('station'),
    stationPosition: makeModel('stationPosition'),
    rotationStyle: makeModel('rotationStyle'),
    guardAssignment: makeModel('guardAssignment'),
    shift: makeModel('shift'),
    tenantUser: makeModel('tenantUser'),
    securityGuard: makeModel('securityGuard'),
    user: makeModel('user'),
  };
  db.tenant.rows.push(makeRow({ id: TENANT, timezone: tz }));
  return db;
}
