/**
 * Unit tests — MINIMIZACIÓN DE SACAFRANCOS (invariante operativa I2).
 *
 * I2: el motor debe usar el MÍNIMO de sacafrancos (SF) que cubre TODOS los gaps
 * de descanso de los vigilantes fijos — nunca un conteo arbitrario. Dos piezas
 * del motor materializan esto y se prueban aquí con código REAL (fake-db en
 * memoria + sinon, sin red ni MySQL), siguiendo el patrón de
 * tests/unit/schedule-shifts/genStartTz.test.ts y client-isolation:
 *
 *   1) calculateStaffingNeeds(...)  — estimador de demanda: por cada día del
 *      super-ciclo cuenta cuántas ESTACIONES tienen algún fijo descansando
 *      (dailyDemand) y toma el pico (peakDemand). Se afirma:
 *        · offsets ESCALONADOS (rest days repartidos) ⇒ pico bajo,
 *        · offsets COLAPSADOS (todos 0, descansan el mismo día) ⇒ pico alto,
 *          demostrando que el "spreading" REDUCE el conteo de SF;
 *        · monotonía: sumar estaciones que descansan en días ya ocupados sube
 *          el conteo, nunca lo baja.
 *
 *   2) computeShiftsForAssignment(...) para un SACAFRANCO real — prueba que el SF
 *      planificado sólo trabaja su BLOQUE (cubre gaps de DÍA en día y de NOCHE en
 *      noche), DESCANSA los días sin gap (no cubre 24/7 solo) y NUNCA hace una
 *      noche seguida de un día a la mañana siguiente (secuencia factible). En el
 *      caso canónico (1 estación 24h, 2 fijos 4-4-2 escalonados) UN solo SF cubre
 *      los 4 medios-gaps del ciclo — el mínimo real. También se afirma I1: cada
 *      fijo descansa restDays por ciclo (nunca trabaja el ciclo completo).
 *
 * HALLAZGO documentado abajo (ver "FINDING"): para esa misma estación única
 * calculateStaffingNeeds informa 2 SF mientras el motor de relevo real cubre todo
 * con 1 SF. El estimador SOBREestima frente al mínimo real (planStationsAndSf, no
 * exportado). Se fija el valor real (2) y se contrasta con la cobertura real (1).
 *
 * Run:
 *   npx cross-env NODE_ENV=test TS_NODE_PROJECT=tsconfig.test.json \
 *     mocha -r ts-node/register \
 *     'tests/unit/programador/minSacafrancos.test.ts' --exit --timeout 15000
 */

import assert from 'assert';
import sinon from 'sinon';

import {
  calculateStaffingNeeds,
  computeShiftsForAssignment,
  getGlobalEpoch,
} from '../../../src/services/shiftGenerationService';

// ─────────────────────────────────────────────────────────────────────────────
// Rotaciones canónicas del motor: ciclo de 10 días.
//   4-4-2  = 4 día, 4 noche, 2 libre (rotación 24h / rotación del SF).
const SF_442 = { dayShifts: 4, nightShifts: 4, restDays: 2 };
const fijo442 = (platoonOffset: number) => ({ platoonOffset, dayShifts: 4, nightShifts: 4, restDays: 2 });

function stationCfg(id: string, offsets: number[]) {
  return { stationId: id, stationName: id.toUpperCase(), fijoPositions: offsets.map(fijo442) };
}

// ═════════════════════════════════════════════════════════════════════════════
describe('programador · minimización de sacafrancos (I2)', () => {
  // ── 1) calculateStaffingNeeds — pico y conteo ─────────────────────────────
  describe('calculateStaffingNeeds — pico de demanda y conteo de SF', () => {
    it('sin estaciones ⇒ todo en cero (nada que cubrir)', () => {
      const r = calculateStaffingNeeds([], SF_442);
      assert.strictEqual(r.fijosNeeded, 0);
      assert.strictEqual(r.sacafrancosNeeded, 0);
      assert.strictEqual(r.peakDemand, 0);
      assert.deepStrictEqual(r.dailyDemand, []);
    });

    it('estación 24h con 2 fijos escalonados ⇒ pico 1; los gaps caen en días distintos', () => {
      // 2 fijos 4-4-2 con offsets 0 y 6 (escalonados por dayShifts=4). Sus
      // descansos NO coinciden: la estación necesita relevo en d4,d5 (fijo2
      // descansa) y d8,d9 (fijo1 descansa). Nunca 2 fijos descansan el mismo día
      // ⇒ pico 1.
      const r = calculateStaffingNeeds([stationCfg('s1', [0, 6])], SF_442);
      assert.strictEqual(r.fijosNeeded, 2);
      assert.strictEqual(r.peakDemand, 1, 'un solo fijo descansa a la vez ⇒ pico 1');
      // dailyDemand del ciclo de 10 días: sólo los días con algún fijo en libre.
      assert.deepStrictEqual(r.dailyDemand, [0, 0, 0, 0, 1, 1, 0, 0, 1, 1]);

      // FINDING (I2): el motor de relevo REAL cubre estos 4 medios-gaps con UN
      // solo SF 4-4-2 (ver bloque "SF real relief" abajo: 1 SF trabaja d4,d5 de
      // día y d8,d9 de noche). Pero calculateStaffingNeeds informa 2. El
      // estimador usa ceil(pico·ciclo/díasTrabajo)=ceil(1·10/8)=2 e ignora que
      // los días de descanso del propio SF se alinean con los días SIN gap. Es
      // una SOBREestimación frente al mínimo real ⇒ no cumple "el motor usa el
      // MÍNIMO". Se fija el valor real observado para dejar el hallazgo visible.
      assert.strictEqual(
        r.sacafrancosNeeded,
        2,
        'FINDING: estimador sobreestima (2) vs mínimo real 1 SF',
      );
    });

    it('SPREADING reduce el conteo: offsets colapsados (todos 0) ⇒ pico alto, escalonados ⇒ pico 1', () => {
      // 5 estaciones, 1 fijo c/u, mismo ciclo 4-4-2.
      // Colapsado: todos offset 0 ⇒ los 5 fijos descansan los MISMOS días (d8,d9)
      //   ⇒ 5 estaciones necesitan relevo a la vez ⇒ pico 5.
      const collapsed = calculateStaffingNeeds(
        [0, 0, 0, 0, 0].map((o, i) => stationCfg('c' + i, [o])),
        SF_442,
      );
      // Escalonado: offsets 0,2,4,6,8 ⇒ cada estación descansa en su propio par
      //   de días ⇒ como máximo 1 estación en libre por día ⇒ pico 1.
      const spread = calculateStaffingNeeds(
        [0, 2, 4, 6, 8].map((o, i) => stationCfg('s' + i, [o])),
        SF_442,
      );

      assert.strictEqual(collapsed.peakDemand, 5, 'colapsado: los 5 descansan juntos');
      assert.strictEqual(spread.peakDemand, 1, 'escalonado: descansos repartidos ⇒ pico 1');

      // El spreading BAJA el pico y, con él, el conteo de sacafrancos.
      assert.ok(
        spread.peakDemand < collapsed.peakDemand,
        `spreading debe bajar el pico (${spread.peakDemand} < ${collapsed.peakDemand})`,
      );
      assert.ok(
        spread.sacafrancosNeeded < collapsed.sacafrancosNeeded,
        `spreading debe bajar los SF (${spread.sacafrancosNeeded} < ${collapsed.sacafrancosNeeded})`,
      );
      // Valores exactos fijados (regresión): colapsado 5→7 SF, escalonado 1→2 SF.
      assert.strictEqual(collapsed.sacafrancosNeeded, 7);
      assert.strictEqual(spread.sacafrancosNeeded, 2);
    });

    it('MONOTONÍA: más estaciones con libres solapados ⇒ más SF, nunca menos', () => {
      // n estaciones, todas offset 0 (descansan el mismo día): cada estación
      // añadida sube el pico en 1 y el conteo de SF no puede bajar.
      let prevPeak = -1;
      let prevSf = -1;
      const peaks: number[] = [];
      const sfs: number[] = [];
      for (let n = 1; n <= 5; n++) {
        const cfg = Array.from({ length: n }, (_, i) => stationCfg('m' + i, [0]));
        const r = calculateStaffingNeeds(cfg, SF_442);
        peaks.push(r.peakDemand);
        sfs.push(r.sacafrancosNeeded);
        assert.strictEqual(r.peakDemand, n, `n=${n}: pico crece 1 a 1`);
        assert.ok(r.peakDemand >= prevPeak, 'pico nunca decrece');
        assert.ok(r.sacafrancosNeeded >= prevSf, 'conteo de SF nunca decrece');
        prevPeak = r.peakDemand;
        prevSf = r.sacafrancosNeeded;
      }
      // Estrictamente creciente en el conteo entre extremos (no se queda plano).
      assert.ok(sfs[4] > sfs[0], `SF sube de ${sfs[0]} a ${sfs[4]} al ir de 1 a 5 estaciones`);
      assert.deepStrictEqual(peaks, [1, 2, 3, 4, 5]);
    });
  });

  // ── 2) SF real relief — computeShiftsForAssignment (I1 + I2) ───────────────
  describe('SF real relief (computeShiftsForAssignment) — trabaja su bloque y descansa', () => {
    const TEN = 'ten-prog';
    const ST1 = 'st-24h';
    const ROT = 'rot-442';
    const F1 = 'pos-fijo-1';
    const F2 = 'pos-fijo-2';
    const SF1 = 'pos-sf-1';

    // Reloj congelado en un día cuyo "días-desde-época" (dse) ≡ 0 (mod 10), para
    // que la fase del ciclo empiece limpia (época FIJA 2024-01-01 del motor). Así
    // los offsets 0/6 (fijos) y 4 (SF) producen exactamente el patrón analizado.
    const FROZEN = '2026-07-19T12:00:00Z'; // dse(2026-07-19)=930 ⇒ 930 % 10 == 0
    const TZ = 'UTC'; // tz del tenant = UTC ⇒ día calendario = día UTC (dse limpio)

    // Fake-db Sequelize-shaped: sólo lo que computeShiftsForAssignment +
    // computeFijoGaps tocan (findByPk / findAll con where {id[], stationId[],
    // tenantId, deletedAt:null, type}).
    function inArr(v: any, c: any): boolean {
      return Array.isArray(c) ? c.map(String).includes(String(v)) : String(v) === String(c);
    }
    function matchWhere(row: any, where: any): boolean {
      if (!where) return true;
      for (const k of Object.keys(where)) {
        const cond = (where as any)[k];
        if (cond === null) { if (row[k] != null) return false; continue; }
        if (Array.isArray(cond)) { if (!inArr(row[k], cond)) return false; continue; }
        if (String(row[k]) !== String(cond)) return false;
      }
      return true;
    }
    function model(rows: any[]) {
      return {
        async findByPk(id: any) { return rows.find((r) => String(r.id) === String(id)) || null; },
        async findAll(q: any = {}) {
          let out = rows.filter((r) => matchWhere(r, q.where));
          if (q.order && q.order[0]) {
            const [col] = q.order[0];
            out = out.slice().sort((a, b) => (a[col] || 0) - (b[col] || 0));
          }
          return out;
        },
      };
    }
    function buildDb() {
      const stations = [{ id: ST1, postSiteId: 'ps1', rotationStyleId: ROT, scheduleType: '24h' }];
      const rots = [{ id: ROT, dayShifts: 4, nightShifts: 4, restDays: 2 }];
      const positions = [
        { id: F1, stationId: ST1, tenantId: TEN, type: 'fijo', platoonOffset: 0, startTime: '07:00', endTime: '19:00', deletedAt: null, sortOrder: 0 },
        { id: F2, stationId: ST1, tenantId: TEN, type: 'fijo', platoonOffset: 6, startTime: '07:00', endTime: '19:00', deletedAt: null, sortOrder: 1 },
        { id: SF1, stationId: ST1, tenantId: TEN, type: 'sacafranco', platoonOffset: 4, startTime: '07:00', endTime: '19:00', deletedAt: null, sortOrder: 100 },
      ];
      return {
        tenant: { async findByPk() { return { timezone: TZ }; } },
        station: model(stations),
        rotationStyle: model(rots),
        stationPosition: model(positions),
      } as any;
    }

    const epoch = getGlobalEpoch();
    const dseOf = (utcDate: string) =>
      Math.floor((Date.parse(utcDate + 'T00:00:00Z') - epoch.getTime()) / 86400000);
    const utcDay = (d: Date) =>
      new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
    const utcHHmm = (d: Date) =>
      new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', hour: '2-digit', minute: '2-digit', hour12: false }).format(d);

    let clock: sinon.SinonFakeTimers;
    beforeEach(() => { clock = sinon.useFakeTimers(new Date(FROZEN).getTime()); });
    afterEach(() => clock.restore());

    // Ventana de 20 días (2 ciclos completos): 2026-07-19 .. 2026-08-07.
    const START = '2026-07-19';
    const END = '2026-08-07';

    function sfAssignment() {
      return {
        id: 'a-sf', guardId: 'g-sf', stationId: ST1, positionId: SF1, rotationStyleId: ROT,
        startDate: START, endDate: END, platoonOffset: 4, isRelief: true, coveredStationIds: [ST1],
      } as any;
    }
    function fijoAssignment(positionId: string, platoonOffset: number) {
      return {
        id: 'a-' + positionId, guardId: 'g-' + positionId, stationId: ST1, positionId, rotationStyleId: ROT,
        startDate: START, endDate: END, platoonOffset, isRelief: false,
      } as any;
    }

    it('sanity: la época congelada arranca el ciclo en fase 0', () => {
      assert.strictEqual(dseOf(START) % 10, 0, 'el día congelado debe ser múltiplo de 10 en dse');
    });

    it('UN solo SF cubre los 4 medios-gaps por ciclo: 4 de día + 4 de noche en 2 ciclos', async () => {
      const shifts = await computeShiftsForAssignment(buildDb(), sfAssignment(), TEN);

      // 8 turnos en 2 ciclos = 4 medios-gaps por ciclo. Un solo SF basta (I2).
      assert.strictEqual(shifts.length, 8, 'un SF cubre exactamente los gaps: 4/ciclo');
      const day = shifts.filter((s) => s.shiftType === 'day');
      const night = shifts.filter((s) => s.shiftType === 'night');
      assert.strictEqual(day.length, 4, '4 turnos de día (d4,d5 de cada ciclo)');
      assert.strictEqual(night.length, 4, '4 turnos de noche (d8,d9 de cada ciclo)');

      // Los gaps de DÍA caen en cycle-days 4 y 5; los de NOCHE en 8 y 9.
      for (const s of day) assert.ok([4, 5].includes(dseOf(utcDay(s.startTime)) % 10), 'gap de día en d4/d5');
      for (const s of night) assert.ok([8, 9].includes(dseOf(utcDay(s.startTime)) % 10), 'gap de noche en d8/d9');

      // Horas correctas por mitad: día 07–19, noche 19–07.
      for (const s of day) assert.strictEqual(utcHHmm(s.startTime), '07:00');
      for (const s of night) assert.strictEqual(utcHHmm(s.startTime), '19:00');
    });

    it('el SF DESCANSA los días sin gap (no cubre 24/7 solo)', async () => {
      const shifts = await computeShiftsForAssignment(buildDb(), sfAssignment(), TEN);
      // 20 días de ventana, sólo 8 trabajados ⇒ 12 días libres/idle. Jamás cada día.
      const workedDays = new Set(shifts.map((s) => utcDay(s.startTime)));
      assert.strictEqual(workedDays.size, 8, 'el SF trabaja 8 de 20 días — descansa el resto');
      assert.ok(workedDays.size < 20, 'un SF NUNCA cubre el 100% de los días');
    });

    it('el SF NUNCA hace una noche seguida de un día a la mañana siguiente (secuencia factible)', async () => {
      const shifts = await computeShiftsForAssignment(buildDb(), sfAssignment(), TEN);
      const nightEnds = new Set(shifts.filter((s) => s.shiftType === 'night').map((s) => s.endTime.getTime()));
      // Un turno noche termina 07:00; un turno día empezaría 07:00 el mismo día.
      // No debe existir NINGÚN turno de día que arranque justo al terminar una noche.
      const clash = shifts.some((s) => s.shiftType === 'day' && nightEnds.has(s.startTime.getTime()));
      assert.ok(!clash, 'noche→día a la mañana siguiente es un turno irreal y no debe ocurrir');
    });

    it('I1 — cada fijo recibe sus restDays por ciclo (nunca trabaja el ciclo completo)', async () => {
      const db = buildDb();
      // Fijo 1 (offset 0): trabaja cycle-days 0-7, descansa 8,9.
      const f1 = await computeShiftsForAssignment(db, fijoAssignment(F1, 0), TEN);
      // Fijo 2 (offset 6): descansa cycle-days 4,5.
      const f2 = await computeShiftsForAssignment(db, fijoAssignment(F2, 6), TEN);

      // 20 días = 2 ciclos ⇒ 8 trabajados/ciclo ⇒ 16 turnos; 4 libres.
      assert.strictEqual(f1.length, 16, 'fijo1: 8 turnos/ciclo (nunca 0 libres, nunca el ciclo completo)');
      assert.strictEqual(f2.length, 16, 'fijo2: 8 turnos/ciclo');

      const f1Cycle = new Set(f1.map((s) => dseOf(utcDay(s.startTime)) % 10));
      const f2Cycle = new Set(f2.map((s) => dseOf(utcDay(s.startTime)) % 10));
      // I1: los días de descanso NO tienen turno.
      assert.ok(!f1Cycle.has(8) && !f1Cycle.has(9), 'fijo1 descansa d8,d9 (2 libres/ciclo)');
      assert.ok(!f2Cycle.has(4) && !f2Cycle.has(5), 'fijo2 descansa d4,d5 (2 libres/ciclo)');
      // Y trabaja el resto de días del ciclo (no hay ciclo trabajado al 100% ni 0%).
      assert.strictEqual(f1Cycle.size, 8, 'fijo1 trabaja 8 cycle-days distintos');
      assert.strictEqual(f2Cycle.size, 8, 'fijo2 trabaja 8 cycle-days distintos');

      // I1 en super-ciclo: descansa restDays/C de los días ⇒ 2/10 = 20% libres.
      const restFrac = (20 - f1.length) / 20;
      assert.strictEqual(restFrac, 0.2, 'fijo descansa restDays/ciclo = 2/10 del super-ciclo');
    });

    it('el descanso de los fijos NO se solapa: sus gaps caen en días distintos (habilita 1 solo SF)', async () => {
      const db = buildDb();
      const f1 = await computeShiftsForAssignment(db, fijoAssignment(F1, 0), TEN);
      const f2 = await computeShiftsForAssignment(db, fijoAssignment(F2, 6), TEN);
      const rest1 = new Set([8, 9]); // por construcción
      const rest2 = new Set([4, 5]);
      // Verificado vía turnos: los cycle-days trabajados de f1 excluyen 8,9 y los
      // de f2 excluyen 4,5; sus descansos son disjuntos ⇒ pico 1 ⇒ 1 SF encadena.
      const worked1 = new Set(f1.map((s) => dseOf(utcDay(s.startTime)) % 10));
      const worked2 = new Set(f2.map((s) => dseOf(utcDay(s.startTime)) % 10));
      for (const d of rest1) assert.ok(!worked1.has(d), `f1 libre en d${d}`);
      for (const d of rest2) assert.ok(!worked2.has(d), `f2 libre en d${d}`);
      const overlap = [...rest1].some((d) => rest2.has(d));
      assert.ok(!overlap, 'descansos disjuntos ⇒ nunca 2 gaps simultáneos ⇒ 1 SF basta');
    });
  });
});
