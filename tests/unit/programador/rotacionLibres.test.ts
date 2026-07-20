/**
 * Unit tests — ROTACIÓN + GARANTÍA DE LIBRES (invariante I1).
 *
 * El motor de rotación vive en src/services/shiftGenerationService.ts. Su núcleo
 * privado getRotationStatus() clasifica cada día del ciclo como 'day'|'night'|
 * 'rest' vía  status(dse) = ((dse - platoonOffset) mod C):
 *     adjustedDay < dayShifts                 => 'day'
 *     adjustedDay < dayShifts + nightShifts   => 'night'
 *     resto                                   => 'rest' (LIBRE)
 * con C = dayShifts + nightShifts + restDays y época FIJA 2024-01-01 (UTC).
 *
 * getRotationStatus NO se exporta, así que lo ejercitamos a través de la función
 * pública computeShiftsForAssignment() — el camino FIJO emite exactamente un
 * turno por cada día trabajado y NINGUNO por cada día libre (shiftType = status).
 * Contar los turnos por día del ciclo reconstruye el patrón D/N/L completo.
 *
 * INVARIANTE I1 (LIBRES): todo vigilante fijo recibe sus restDays por ciclo —
 * nunca 0 libres, nunca trabaja el ciclo completo. En un super-ciclo de K ciclos
 * trabaja EXACTAMENTE K·(dayShifts+nightShifts) días y descansa EXACTAMENTE
 * K·restDays. Afirmamos esto para 4-4-2, 8-2, 5-2, 6-1 y 1-1, más el escalonado
 * de los DOS fijos de una estación 24h (uno día / otro noche, se intercambian).
 *
 * fake-db en memoria (sin red, sin DB real), reloj congelado con sinon — mismo
 * patrón que tests/unit/schedule-shifts/genStartTz.test.ts.
 *
 * Run:
 *   npx cross-env NODE_ENV=test TS_NODE_PROJECT=tsconfig.test.json \
 *     mocha -r ts-node/register \
 *     'tests/unit/programador/rotacionLibres.test.ts' --exit --timeout 15000
 */

import assert from 'assert';
import sinon from 'sinon';

import { computeShiftsForAssignment, ComputedShift } from '../../../src/services/shiftGenerationService';

// UTC como tz del tenant: así el día de calendario del turno == el día UTC de su
// startTime, y bucketear cada turno por su día del ciclo es exacto (07:00Z y
// 19:00Z caen ambos dentro del mismo día UTC de su fecha).
const TZ = 'UTC';
const TENANT = 'tenant-rot';

// Época fija del motor (debe coincidir con ROTATION_EPOCH del servicio).
const EPOCH_MS = Date.UTC(2024, 0, 1);
const DAY_MS = 24 * 60 * 60 * 1000;

// Reloj congelado: 2026-01-01 12:00Z. Con tz=UTC, "hoy" del tenant = 2026-01-01.
const NOW_ISO = '2026-01-01T12:00:00Z';
const TODAY_STR = '2026-01-01';

/** Días desde la época fija hasta la medianoche UTC de una fecha YYYY-MM-DD. */
function dseOf(dateStr: string): number {
  return Math.floor((Date.parse(`${dateStr}T00:00:00Z`) - EPOCH_MS) / DAY_MS);
}

/** YYYY-MM-DD de (medianoche UTC de baseStr) + n días. */
function addDays(baseStr: string, n: number): string {
  const d = new Date(Date.parse(`${baseStr}T00:00:00Z`) + n * DAY_MS);
  return d.toISOString().slice(0, 10);
}

interface Rot { dayShifts: number; nightShifts: number; restDays: number }

// fake db Sequelize-shaped: sólo lo que toca el camino FIJO de
// computeShiftsForAssignment (tz, estación, estilo de rotación, posición).
function buildDb(rot: Rot, posStart = '07:00', posEnd = '19:00') {
  return {
    tenant: { findByPk: async () => ({ timezone: TZ }) },
    station: { findByPk: async () => ({ postSiteId: 'ps-1', rotationStyleId: 'rot-1' }) },
    rotationStyle: { findByPk: async () => ({ ...rot }) },
    stationPosition: { findByPk: async () => ({ type: 'fijo', startTime: posStart, endTime: posEnd }) },
  } as any;
}

/**
 * Corre el motor para UN fijo sobre K ciclos completos y devuelve el mapa
 * (índice de día 0..K·C-1) => turno. platoonOffset por defecto se alinea para que
 * el día 0 (genStart) sea la posición 0 del ciclo, dejando el patrón D/N/L legible.
 */
async function runFijo(rot: Rot, K: number, offsetOverride?: number) {
  const C = rot.dayShifts + rot.nightShifts + rot.restDays;
  const dseStart = dseOf(TODAY_STR);
  const aligned = ((dseStart % C) + C) % C; // pos 0 del ciclo == genStart
  const platoonOffset = offsetOverride === undefined ? aligned : offsetOverride;
  const db = buildDb(rot);
  const assignment: any = {
    id: 'a-1',
    guardId: 'g-1',
    stationId: 'st-1',
    positionId: 'pos-1',
    rotationStyleId: 'rot-1',
    startDate: TODAY_STR,
    endDate: addDays(TODAY_STR, K * C - 1), // ventana = exactamente K·C días
    platoonOffset,
    isRelief: false,
    kind: 'rotation',
  };
  const shifts: ComputedShift[] = await computeShiftsForAssignment(db, assignment, TENANT);

  const byDay = new Map<number, ComputedShift>();
  for (const s of shifts) {
    const dse = Math.floor((s.startTime.getTime() - EPOCH_MS) / DAY_MS);
    byDay.set(dse - dseStart, s);
  }
  return { C, K, dseStart, platoonOffset, shifts, byDay };
}

/** Corrida máxima de días LIBRES consecutivos en una ventana de W días. */
function maxRestRun(byDay: Map<number, ComputedShift>, W: number): number {
  let run = 0, max = 0;
  for (let i = 0; i < W; i++) {
    if (byDay.has(i)) { run = 0; } else { run += 1; if (run > max) max = run; }
  }
  return max;
}

// ═══════════════════════════════════════════════════════════════════════════
describe('programador · rotación + garantía de LIBRES (I1)', () => {
  let clock: sinon.SinonFakeTimers;
  beforeEach(() => { clock = sinon.useFakeTimers(new Date(NOW_ISO).getTime()); });
  afterEach(() => clock.restore());

  // Los cinco estilos que el usuario exige. Valores tal cual el seed del sistema:
  //   5-2 => 5/0/2   6-1 => 6/0/1   4-4-2 => 4/4/2   8-2 => 8/0/2 (ensureRotationStyle)
  //   1-1 => 1/0/1   (mínimo: un día trabaja, un día libre)
  const STYLES: { name: string; rot: Rot }[] = [
    { name: '4-4-2', rot: { dayShifts: 4, nightShifts: 4, restDays: 2 } },
    { name: '8-2',   rot: { dayShifts: 8, nightShifts: 0, restDays: 2 } },
    { name: '5-2',   rot: { dayShifts: 5, nightShifts: 0, restDays: 2 } },
    { name: '6-1',   rot: { dayShifts: 6, nightShifts: 0, restDays: 1 } },
    { name: '1-1',   rot: { dayShifts: 1, nightShifts: 0, restDays: 1 } },
  ];

  const K = 3; // super-ciclo = 3 ciclos completos

  for (const { name, rot } of STYLES) {
    describe(`${name} (D=${rot.dayShifts} N=${rot.nightShifts} L=${rot.restDays})`, () => {
      it('el fijo trabaja exactamente K·(D+N) y descansa exactamente K·L en el super-ciclo', async () => {
        const { C, byDay } = await runFijo(rot, K);
        const workDaysPerCycle = rot.dayShifts + rot.nightShifts;
        const W = K * C;

        const worked = byDay.size;
        const rested = W - worked;

        assert.strictEqual(worked, K * workDaysPerCycle,
          `${name}: trabajó ${worked}, esperado ${K * workDaysPerCycle}`);
        assert.strictEqual(rested, K * rot.restDays,
          `${name}: descansó ${rested}, esperado ${K * rot.restDays}`);
      });

      it('NUNCA queda con 0 libres ni trabaja el ciclo completo (I1)', async () => {
        const { C, byDay } = await runFijo(rot, K);
        const W = K * C;
        const rested = W - byDay.size;
        assert.ok(rested > 0, `${name}: 0 libres — viola I1`);
        assert.ok(byDay.size < W, `${name}: trabajó el super-ciclo completo — viola I1`);
        // Cada ciclo individual también debe contener sus libres.
        for (let k = 0; k < K; k++) {
          let restInCycle = 0;
          for (let p = 0; p < C; p++) if (!byDay.has(k * C + p)) restInCycle += 1;
          assert.strictEqual(restInCycle, rot.restDays,
            `${name}: ciclo ${k} tuvo ${restInCycle} libres, esperado ${rot.restDays}`);
        }
      });

      it('el patrón D/N/L por ciclo es el canónico (día → noche → libre) y se repite', async () => {
        const { C, byDay } = await runFijo(rot, K);
        for (let k = 0; k < K; k++) {
          for (let p = 0; p < C; p++) {
            const idx = k * C + p;
            const s = byDay.get(idx);
            if (p < rot.dayShifts) {
              assert.ok(s, `${name} ciclo ${k} pos ${p}: esperaba turno de DÍA, no hubo turno`);
              assert.strictEqual(s!.shiftType, 'day',
                `${name} ciclo ${k} pos ${p}: esperaba 'day', fue '${s!.shiftType}'`);
            } else if (p < rot.dayShifts + rot.nightShifts) {
              assert.ok(s, `${name} ciclo ${k} pos ${p}: esperaba turno de NOCHE, no hubo turno`);
              assert.strictEqual(s!.shiftType, 'night',
                `${name} ciclo ${k} pos ${p}: esperaba 'night', fue '${s!.shiftType}'`);
            } else {
              assert.strictEqual(s, undefined,
                `${name} ciclo ${k} pos ${p}: esperaba LIBRE, hubo un turno`);
            }
          }
        }
      });

      it('los libres no se encadenan mal: la corrida máxima de libres == restDays', async () => {
        const { C, byDay } = await runFijo(rot, K);
        const W = K * C;
        // El bloque de descanso es contiguo dentro del ciclo, e inmediatamente
        // seguido por trabajo del ciclo siguiente => la corrida más larga de
        // libres en toda la ventana es exactamente restDays (para 1-1: 1, nunca
        // dos libres pegados).
        assert.strictEqual(maxRestRun(byDay, W), rot.restDays,
          `${name}: corrida de libres != restDays (encadenamiento inválido)`);
      });
    });
  }

  // ── Escalonado de los DOS fijos de una estación 24h (4-4-2) ────────────────
  // offset del fijo A = base (alineado a genStart); fijo B = base - dayShifts.
  // Resultado esperado por ciclo (C=10, D=N=4, L=2):
  //   A: día 0-3, noche 4-7, LIBRE 8-9
  //   B: noche 0-3, LIBRE 4-5, día 6-9
  // => en 0-3 uno hace DÍA y el otro NOCHE; en 6-7 ya se intercambiaron
  //    (A noche / B día); los descansos caen en días DISTINTOS (pico 1) para que
  //    un solo sacafranco pueda encadenarlos.
  describe('24h 4-4-2 · escalonado de los dos fijos (base y base-dayShifts)', () => {
    const rot: Rot = { dayShifts: 4, nightShifts: 4, restDays: 2 };
    const C = 10;
    const K = 2;

    async function runPair() {
      const dseStart = dseOf(TODAY_STR);
      const base = ((dseStart % C) + C) % C;                 // fijo A, pos 0 == genStart
      const offB = ((base - rot.dayShifts) % C + C) % C;     // fijo B escalonado
      const A = await runFijo(rot, K, base);
      const B = await runFijo(rot, K, offB);
      return { A, B, base, offB };
    }

    it('cada fijo descansa EXACTAMENTE restDays por ciclo (ninguno con 0 libres)', async () => {
      const { A, B } = await runPair();
      const W = K * C;
      assert.strictEqual(W - A.byDay.size, K * rot.restDays, 'fijo A: libres != K·restDays');
      assert.strictEqual(W - B.byDay.size, K * rot.restDays, 'fijo B: libres != K·restDays');
      assert.ok(W - A.byDay.size > 0 && W - B.byDay.size > 0, 'algún fijo con 0 libres');
    });

    it('los descansos están escalonados: A libra días 8-9, B libra días 4-5 del ciclo (disjuntos)', async () => {
      const { A, B } = await runPair();
      for (let k = 0; k < K; k++) {
        // A descansa en posiciones 8,9
        assert.ok(!A.byDay.has(k * C + 8) && !A.byDay.has(k * C + 9), `A debería librar 8-9 del ciclo ${k}`);
        // B descansa en posiciones 4,5
        assert.ok(!B.byDay.has(k * C + 4) && !B.byDay.has(k * C + 5), `B debería librar 4-5 del ciclo ${k}`);
      }
    });

    it('NUNCA descansan ambos el mismo día (pico de gaps == 1 => un solo sacafranco encadena)', async () => {
      const { A, B } = await runPair();
      const W = K * C;
      for (let i = 0; i < W; i++) {
        const aRest = !A.byDay.has(i);
        const bRest = !B.byDay.has(i);
        assert.ok(!(aRest && bRest), `día ${i}: ambos fijos descansan — rompe el escalonado (pico > 1)`);
      }
    });

    it('en la primera mitad del ciclo (0-3) uno hace DÍA y el otro NOCHE', async () => {
      const { A, B } = await runPair();
      for (let p = 0; p < 4; p++) {
        const a = A.byDay.get(p);
        const b = B.byDay.get(p);
        assert.ok(a && b, `día ${p}: ambos fijos deberían trabajar`);
        assert.strictEqual(a!.shiftType, 'day', `día ${p}: A debería hacer DÍA`);
        assert.strictEqual(b!.shiftType, 'night', `día ${p}: B debería hacer NOCHE`);
      }
    });

    it('en días 6-7 los roles se INTERCAMBIAN (A noche / B día)', async () => {
      const { A, B } = await runPair();
      for (const p of [6, 7]) {
        const a = A.byDay.get(p);
        const b = B.byDay.get(p);
        assert.ok(a && b, `día ${p}: ambos fijos deberían trabajar`);
        assert.strictEqual(a!.shiftType, 'night', `día ${p}: A debería haberse intercambiado a NOCHE`);
        assert.strictEqual(b!.shiftType, 'day', `día ${p}: B debería haberse intercambiado a DÍA`);
      }
    });
  });
});
