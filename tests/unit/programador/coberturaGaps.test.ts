/**
 * Unit tests — COBERTURA COMPLETA + turno REAL del sacafranco.
 *
 * Cubre la rama SACAFRANCO de computeShiftsForAssignment (src/services/
 * shiftGenerationService.ts) + el analizador de cobertura (scheduleCoverageService).
 * La promesa del motor: el SF NO corre "su propia rotación en el aire" — va DONDE
 * hay un gap real de descanso de un fijo, en la MITAD correcta (día en su bloque
 * de día, noche en su bloque de noche), y NUNCA emite un turno irreal (noche y a
 * la mañana siguiente día). Un gap fuera del bloque del SF NO se cubre por arte
 * de magia: queda marcado por el analizador.
 *
 * Todo es determinista: fijamos el reloj en la ÉPOCA de rotación (2024-01-01, la
 * fuente de verdad del motor) y elegimos offsets a mano, de modo que sabemos
 * EXACTAMENTE en qué día cae cada descanso y qué debe emitir el SF. tz = 'UTC'
 * para que 07:00→día y 19:00→noche sin ambigüedad de zona.
 *
 * Ciclo canónico 4-4-2 (día,día,día,día,noche,noche,noche,noche,libre,libre):
 * el SF trabaja su bloque de DÍA, luego su bloque de NOCHE, luego descansa — el
 * descanso separa el último turno de noche del primer día del siguiente ciclo,
 * así que la secuencia es SIEMPRE factible.
 *
 * INVARIANTES afirmadas:
 *  (I-cobertura) Con SF suficientes, cada gap de descanso de un fijo queda cubierto
 *               (gapCount === 0 en el analizador real sobre fijos + SF).
 *  (I-turno-real) El SF nunca emite una noche seguida de un día a la mañana siguiente.
 *  (I-no-magia)  Un gap fuera del bloque del SF NO se cubre: el analizador lo marca.
 *
 * Run:
 *   npx cross-env NODE_ENV=test TS_NODE_PROJECT=tsconfig.test.json \
 *     mocha -r ts-node/register \
 *     'tests/unit/programador/coberturaGaps.test.ts' --exit --timeout 15000
 */

import assert from 'assert';
import sinon from 'sinon';

import { computeShiftsForAssignment, ComputedShift } from '../../../src/services/shiftGenerationService';
import { computeCoverage, StationReq } from '../../../src/services/scheduleCoverageService';

const TZ = 'UTC';

// The rotation epoch the engine uses (Jan 1 2024 UTC). We freeze "today" here so
// genStart lands on dse 0 and the 4-4-2 cycle starts clean at cycle-position 0.
const EPOCH_ISO = '2024-01-01';

// ─────────────────────────── Sequelize-shaped fake db ───────────────────────
// where matcher: plain equality (null included) + array → SQL IN. All our where
// clauses use only these forms (no Op operators), so this stays tiny.
function matchWhere(row: any, where: any): boolean {
  if (!where) return true;
  for (const field of Object.keys(where)) {
    const cond = where[field];
    const actual = row[field];
    if (Array.isArray(cond)) {
      if (!cond.map(String).includes(String(actual))) return false;
      continue;
    }
    if (cond === null) {
      if (actual != null) return false;
      continue;
    }
    if (String(actual) !== String(cond)) return false;
  }
  return true;
}

function makeModel(seed: any[]) {
  const model: any = {
    rows: seed.slice(),
    async findByPk(id: any) {
      return model.rows.find((r: any) => String(r.id) === String(id)) || null;
    },
    async findAll(q: any = {}) {
      let out = model.rows.filter((r: any) => matchWhere(r, q.where));
      if (q.order && q.order.length) {
        const [[col, dir]] = q.order;
        out = out.slice().sort((a: any, b: any) => {
          const av = a[col], bv = b[col];
          const cmp = av < bv ? -1 : av > bv ? 1 : 0;
          return dir === 'DESC' ? -cmp : cmp;
        });
      }
      return out;
    },
    async findOne(q: any = {}) {
      return model.rows.find((r: any) => matchWhere(r, q.where)) || null;
    },
  };
  return model;
}

function buildDb(seed: Record<string, any[]>) {
  const db: any = { Sequelize: { Op: {} } };
  for (const name of ['tenant', 'station', 'rotationStyle', 'stationPosition']) {
    db[name] = makeModel(seed[name] || []);
  }
  return db;
}

// Rotation styles (dayShifts, nightShifts, restDays).
const RS442 = { id: 'rs-442', dayShifts: 4, nightShifts: 4, restDays: 2 }; // cycle 10
const RS52 = { id: 'rs-52', dayShifts: 5, nightShifts: 0, restDays: 2 };   // 12h → cycle 7
const RS_ALLNIGHT = { id: 'rs-allnight', dayShifts: 0, nightShifts: 1, restDays: 0 }; // always working, night half
const RS_1_1_0 = { id: 'rs-110', dayShifts: 1, nightShifts: 1, restDays: 0 }; // cycle 2, NO rest

const TENANT = 'ten-1';

// Build a fijo/SF assignment shaped like AssignmentData.
function assignment(o: Partial<any> & { id: string; positionId: string; stationId: string }): any {
  return {
    guardId: `guard-${o.id}`,
    rotationStyleId: null,
    startDate: EPOCH_ISO,
    endDate: null,
    platoonOffset: 0,
    isRelief: false,
    kind: 'rotation',
    coveredStationIds: null,
    ...o,
  };
}

/** Local date (UTC) of a shift start, e.g. '2024-01-03'. */
function dateOf(d: Date): string {
  return new Date(d).toISOString().slice(0, 10);
}
/**
 * dse (days since the 2024-01-01 epoch) of a shift's CALENDAR day. Derived from
 * the local date, not the raw instant: a night shift starts at 19:00, so
 * (instant - epoch) would round the fractional day up. The engine buckets by
 * calendar day (localDate), and so must we.
 */
function dseOf(d: Date): number {
  const epoch = Date.UTC(2024, 0, 1);
  const dayStart = Date.parse(`${dateOf(d)}T00:00:00Z`);
  return Math.round((dayStart - epoch) / 86_400_000);
}
/** HH:mm (UTC) of a shift start. */
function hhmm(d: Date): string {
  return new Date(d).toISOString().slice(11, 16);
}

// Freeze "today" at the epoch noon so genStart == 2024-01-01 (dse 0).
// NOTE: these hooks MUST live inside the describe — root-level beforeEach/
// afterEach apply across ALL test files in the mocha run, and installing a
// fake clock globally makes a sibling file's own useFakeTimers throw "already
// installed". Keeping them describe-scoped fixes the cross-file suite run.
let clock: sinon.SinonFakeTimers;

// ════════════════════════════════════════════════════════════════════════════
describe('programador · cobertura completa + turno real del sacafranco', () => {
  beforeEach(() => {
    clock = sinon.useFakeTimers(new Date(`${EPOCH_ISO}T12:00:00Z`).getTime());
  });
  afterEach(() => {
    if (clock) clock.restore();
    sinon.restore();
  });
  // ── Canónico: 24h, 2 fijos escalonados, 1 SF cubre TODO ────────────────────
  //
  // Estación 24h, rotación 4-4-2. Dos fijos escalonados por dayShifts(=4):
  //   fijo1 offset 0, fijo2 offset 4. Gaps por ciclo (dse 0..9):
  //     noche @ dse 2,3   (fijo1 hace día, fijo2 descansa)
  //     día   @ dse 8,9   (fijo1 descansa, fijo2 hace noche)
  //   El SF 4-4-2 con offset 8 tiene su bloque de DÍA en dse {8,9,0,1} y su
  //   bloque de NOCHE en dse {2,3,4,5}, descanso dse {6,7}. Cubre EXACTAMENTE
  //   los 4 gaps y a nadie más.
  describe('estación 24h · 2 fijos escalonados · 1 SF con offset alineado', () => {
    function seed() {
      return buildDb({
        tenant: [{ id: TENANT, timezone: TZ }],
        rotationStyle: [RS442],
        station: [{ id: 'st-24', tenantId: TENANT, scheduleType: '24h', rotationStyleId: 'rs-442', postSiteId: 'ps-1' }],
        stationPosition: [
          { id: 'fijo1', tenantId: TENANT, stationId: 'st-24', type: 'fijo', startTime: '07:00', endTime: '19:00', platoonOffset: 0, sortOrder: 0, deletedAt: null },
          { id: 'fijo2', tenantId: TENANT, stationId: 'st-24', type: 'fijo', startTime: '07:00', endTime: '19:00', platoonOffset: 4, sortOrder: 1, deletedAt: null },
          { id: 'sf1', tenantId: TENANT, stationId: 'st-24', type: 'sacafranco', startTime: '07:00', endTime: '19:00', platoonOffset: 8, sortOrder: 100, deletedAt: null },
        ],
      });
    }

    const oneCycle = { endDate: '2024-01-10' }; // dse 0..9 inclusive

    async function sfShifts(db: any): Promise<ComputedShift[]> {
      return computeShiftsForAssignment(
        db,
        assignment({ id: 'sf1', positionId: 'sf1', stationId: 'st-24', isRelief: true, platoonOffset: 8, coveredStationIds: ['st-24'], ...oneCycle }),
        TENANT,
      );
    }

    it('el SF cubre exactamente los 4 gaps: noche@dse2,3 y día@dse8,9 (nada más)', async () => {
      const shifts = await sfShifts(seed());
      const byDse = shifts.map((s) => ({ dse: dseOf(s.startTime), type: s.shiftType, hhmm: hhmm(s.startTime), station: s.stationId }));
      byDse.sort((a, b) => a.dse - b.dse);

      assert.strictEqual(shifts.length, 4, `SF debe emitir 4 turnos (los 4 gaps), emitió ${shifts.length}: ${JSON.stringify(byDse)}`);
      // Todos en la estación cubierta.
      assert.ok(shifts.every((s) => s.stationId === 'st-24'), 'todos los turnos del SF caen en la estación cubierta');

      const nights = byDse.filter((s) => s.type === 'night').map((s) => s.dse);
      const days = byDse.filter((s) => s.type === 'day').map((s) => s.dse);
      assert.deepStrictEqual(nights, [2, 3], `gaps de noche en dse 2,3 → turnos de noche del SF; got ${JSON.stringify(nights)}`);
      assert.deepStrictEqual(days, [8, 9], `gaps de día en dse 8,9 → turnos de día del SF; got ${JSON.stringify(days)}`);

      // Horas reales de cada mitad.
      for (const s of byDse) {
        if (s.type === 'night') assert.strictEqual(s.hhmm, '19:00', 'turno de noche arranca 19:00');
        if (s.type === 'day') assert.strictEqual(s.hhmm, '07:00', 'turno de día arranca 07:00');
      }
    });

    it('(I-turno-real) el SF nunca emite una noche seguida de un día a la mañana siguiente', async () => {
      const shifts = await sfShifts(seed());
      const typeByDate = new Map<string, string>();
      for (const s of shifts) typeByDate.set(dateOf(s.startTime), s.shiftType);
      for (const [date, type] of typeByDate) {
        if (type !== 'night') continue;
        const next = new Date(`${date}T00:00:00Z`);
        next.setUTCDate(next.getUTCDate() + 1);
        const nextType = typeByDate.get(next.toISOString().slice(0, 10));
        assert.notStrictEqual(nextType, 'day', `turno IRREAL: noche el ${date} seguida de día el ${next.toISOString().slice(0, 10)}`);
      }
    });

    it('(I-cobertura) fijos + SF ⇒ cobertura completa: 0 gaps y 0 sobre-cobertura (analizador real)', async () => {
      const db = seed();
      const f1 = await computeShiftsForAssignment(db, assignment({ id: 'fijo1', positionId: 'fijo1', stationId: 'st-24', platoonOffset: 0, ...oneCycle }), TENANT);
      const f2 = await computeShiftsForAssignment(db, assignment({ id: 'fijo2', positionId: 'fijo2', stationId: 'st-24', platoonOffset: 4, ...oneCycle }), TENANT);
      const sf = await sfShifts(db);

      const all = [...f1, ...f2, ...sf].map((s) => ({ stationId: s.stationId, guardId: s.guardId, startTime: s.startTime }));
      const req: StationReq[] = [{ stationId: 'st-24', halves: ['day', 'night'] }];
      const cov = computeCoverage(all, req, new Date(Date.UTC(2024, 0, 1)), 10, TZ);

      assert.strictEqual(cov.gapCount, 0, `esperaba 0 gaps, hay ${cov.gapCount}: ${JSON.stringify(cov.gaps)}`);
      assert.strictEqual(cov.overstaffCount, 0, `esperaba 0 sobre-cobertura, hay ${cov.overstaffCount}: ${JSON.stringify(cov.overstaff)}`);
      assert.strictEqual(cov.coveredPct, 100);
    });
  });

  // ── (I-no-magia): SF con offset DESALINEADO no cubre los gaps ───────────────
  //
  // Mismos fijos, pero el SF con offset 0: su bloque de día (dse 0-3) cae sobre
  // días SIN gap de día, su bloque de noche (dse 4-7) sobre días SIN gap de
  // noche, y los gaps reales (noche@2,3 / día@8,9) caen fuera de bloque o en su
  // descanso. El SF NO puede cubrirlos: emite 0 turnos y el analizador marca los
  // 4 gaps. Prueba que la relevación es REAL (atada al bloque), no mágica.
  describe('estación 24h · SF con offset desalineado (gap fuera de bloque)', () => {
    function seed() {
      return buildDb({
        tenant: [{ id: TENANT, timezone: TZ }],
        rotationStyle: [RS442],
        station: [{ id: 'st-24', tenantId: TENANT, scheduleType: '24h', rotationStyleId: 'rs-442', postSiteId: 'ps-1' }],
        stationPosition: [
          { id: 'fijo1', tenantId: TENANT, stationId: 'st-24', type: 'fijo', startTime: '07:00', endTime: '19:00', platoonOffset: 0, sortOrder: 0, deletedAt: null },
          { id: 'fijo2', tenantId: TENANT, stationId: 'st-24', type: 'fijo', startTime: '07:00', endTime: '19:00', platoonOffset: 4, sortOrder: 1, deletedAt: null },
          { id: 'sf1', tenantId: TENANT, stationId: 'st-24', type: 'sacafranco', startTime: '07:00', endTime: '19:00', platoonOffset: 0, sortOrder: 100, deletedAt: null },
        ],
      });
    }

    it('el SF desalineado NO cubre por arte de magia: 0 turnos y el analizador marca los 4 gaps', async () => {
      const db = seed();
      const sf = await computeShiftsForAssignment(
        db,
        assignment({ id: 'sf1', positionId: 'sf1', stationId: 'st-24', isRelief: true, platoonOffset: 0, coveredStationIds: ['st-24'], endDate: '2024-01-10' }),
        TENANT,
      );
      assert.strictEqual(sf.length, 0, `SF desalineado no debe emitir turnos, emitió ${sf.length}: ${JSON.stringify(sf.map((s) => ({ dse: dseOf(s.startTime), t: s.shiftType })))}`);

      const f1 = await computeShiftsForAssignment(db, assignment({ id: 'fijo1', positionId: 'fijo1', stationId: 'st-24', platoonOffset: 0, endDate: '2024-01-10' }), TENANT);
      const f2 = await computeShiftsForAssignment(db, assignment({ id: 'fijo2', positionId: 'fijo2', stationId: 'st-24', platoonOffset: 4, endDate: '2024-01-10' }), TENANT);
      const all = [...f1, ...f2, ...sf].map((s) => ({ stationId: s.stationId, guardId: s.guardId, startTime: s.startTime }));
      const cov = computeCoverage(all, [{ stationId: 'st-24', halves: ['day', 'night'] }], new Date(Date.UTC(2024, 0, 1)), 10, TZ);

      assert.strictEqual(cov.gapCount, 4, `esperaba 4 gaps residuales, hay ${cov.gapCount}: ${JSON.stringify(cov.gaps)}`);
      // Los gaps residuales son exactamente noche@dse2,3 y día@dse8,9.
      const gapKeys = cov.gaps.map((g) => `${g.date}|${g.half}`).sort();
      assert.deepStrictEqual(gapKeys, [
        '2024-01-03|night', '2024-01-04|night', '2024-01-09|day', '2024-01-10|day',
      ], `gaps residuales inesperados: ${JSON.stringify(gapKeys)}`);
    });
  });

  // ── 12h-night: mapeo de mitad (coveredHalf / halfHours) ────────────────────
  //
  // Una estación 12h-night corre 5-2 (nightShifts=0 ⇒ status 'day') pero el fijo
  // cubre la mitad de NOCHE. El descanso del fijo deja un gap de NOCHE que el SF
  // debe cubrir con un turno 19:00→07:00 (no 07:00→19:00). El SF corre una
  // rotación "siempre noche" (home station aparte) para que cada día de trabajo
  // busque gaps de noche.
  describe('estación 12h-night · el gap de descanso se mapea a la mitad de NOCHE', () => {
    function seed() {
      return buildDb({
        tenant: [{ id: TENANT, timezone: TZ }],
        rotationStyle: [RS52, RS_ALLNIGHT],
        station: [
          // La estación de noche: fijo con horas nocturnas (19:00→07:00).
          { id: 'st-night', tenantId: TENANT, scheduleType: '12h-night', rotationStyleId: 'rs-52', postSiteId: 'ps-2' },
          // Home del SF: solo aporta su rotación (siempre noche).
          { id: 'st-sfhome', tenantId: TENANT, scheduleType: '12h-night', rotationStyleId: 'rs-allnight', postSiteId: 'ps-2' },
        ],
        stationPosition: [
          { id: 'fijoN', tenantId: TENANT, stationId: 'st-night', type: 'fijo', startTime: '19:00', endTime: '07:00', platoonOffset: 0, sortOrder: 0, deletedAt: null },
          { id: 'sfN', tenantId: TENANT, stationId: 'st-sfhome', type: 'sacafranco', startTime: '19:00', endTime: '07:00', platoonOffset: 0, sortOrder: 100, deletedAt: null },
        ],
      });
    }

    it('el SF cubre el gap de noche con un turno 19:00→07:00 y marca night, nunca 07:00→19:00', async () => {
      const db = seed();
      const sf = await computeShiftsForAssignment(
        db,
        assignment({ id: 'sfN', positionId: 'sfN', stationId: 'st-sfhome', isRelief: true, platoonOffset: 0, coveredStationIds: ['st-night'], endDate: '2024-01-07' }),
        TENANT,
      );
      // Fijo 5-2 offset 0 descansa dse 5,6 (los únicos gaps de noche en dse 0..6).
      const byDse = sf.map((s) => ({ dse: dseOf(s.startTime), type: s.shiftType, hhmm: hhmm(s.startTime), station: s.stationId })).sort((a, b) => a.dse - b.dse);
      assert.strictEqual(sf.length, 2, `SF debe cubrir 2 gaps de noche (dse 5,6), emitió ${sf.length}: ${JSON.stringify(byDse)}`);
      assert.deepStrictEqual(byDse.map((s) => s.dse), [5, 6]);
      for (const s of byDse) {
        assert.strictEqual(s.type, 'night', 'el gap de una 12h-night se mapea a la mitad de NOCHE');
        assert.strictEqual(s.hhmm, '19:00', 'turno nocturno arranca 19:00 (no 07:00)');
        assert.strictEqual(s.station, 'st-night', 'el SF va a la estación cubierta, no a su home');
      }
    });

    it('(I-cobertura) fijo 12h-night + SF ⇒ mitad de noche cubierta todos los días, 0 gaps', async () => {
      const db = seed();
      const fijo = await computeShiftsForAssignment(db, assignment({ id: 'fijoN', positionId: 'fijoN', stationId: 'st-night', platoonOffset: 0, endDate: '2024-01-07' }), TENANT);
      const sf = await computeShiftsForAssignment(db, assignment({ id: 'sfN', positionId: 'sfN', stationId: 'st-sfhome', isRelief: true, platoonOffset: 0, coveredStationIds: ['st-night'], endDate: '2024-01-07' }), TENANT);

      // Todo turno debe CLASIFICAR como noche por su hora de inicio (19:00). Ojo:
      // el fijo de una 12h-night lleva shiftType='day' (el status crudo de la
      // rotación 5-2), pero sus HORAS son 19:00→07:00, así que classifyHalf lo
      // cuenta como noche. El SF sí marca shiftType='night'. La cobertura se
      // decide por la hora de inicio, no por el shiftType.
      for (const s of [...fijo, ...sf]) assert.strictEqual(hhmm(s.startTime), '19:00', `turno de 12h-night debe arrancar 19:00 (mitad noche): ${JSON.stringify({ dse: dseOf(s.startTime), t: s.shiftType, h: hhmm(s.startTime) })}`);

      const all = [...fijo, ...sf].map((s) => ({ stationId: 'st-night', guardId: s.guardId, startTime: s.startTime }));
      const cov = computeCoverage(all, [{ stationId: 'st-night', halves: ['night'] }], new Date(Date.UTC(2024, 0, 1)), 7, TZ);
      assert.strictEqual(cov.gapCount, 0, `esperaba 0 gaps de noche, hay ${cov.gapCount}: ${JSON.stringify(cov.gaps)}`);
      assert.strictEqual(cov.overstaffCount, 0, `esperaba 0 sobre-cobertura, hay ${cov.overstaffCount}: ${JSON.stringify(cov.overstaff)}`);
    });
  });

  // ── Varios SF reparten gaps simultáneos de la misma mitad (por sfIndex) ─────
  //
  // Dos estaciones 24h, cada una con UN fijo offset 0. En dse 4..7 ambos fijos
  // hacen noche ⇒ ambas estaciones tienen gap de DÍA simultáneo. Se necesitan 2
  // SF; el runtime los reparte por índice (sfIndex): SF0 toma gaps[0], SF1 toma
  // gaps[1] (ordenados por stationId). Afirma que "con SF suficientes cada gap
  // queda cubierto".
  describe('varios sacafrancos · reparto de gaps simultáneos de la misma mitad', () => {
    function seed() {
      return buildDb({
        tenant: [{ id: TENANT, timezone: TZ }],
        rotationStyle: [RS442],
        station: [
          { id: 'st-a', tenantId: TENANT, scheduleType: '24h', rotationStyleId: 'rs-442', postSiteId: 'ps-a' },
          { id: 'st-b', tenantId: TENANT, scheduleType: '24h', rotationStyleId: 'rs-442', postSiteId: 'ps-b' },
        ],
        stationPosition: [
          { id: 'fa', tenantId: TENANT, stationId: 'st-a', type: 'fijo', startTime: '07:00', endTime: '19:00', platoonOffset: 0, sortOrder: 0, deletedAt: null },
          { id: 'fb', tenantId: TENANT, stationId: 'st-b', type: 'fijo', startTime: '07:00', endTime: '19:00', platoonOffset: 0, sortOrder: 0, deletedAt: null },
          // Dos SF con offset 4: bloque de día en dse 4..7 (donde están los gaps de día).
          { id: 'sfA', tenantId: TENANT, stationId: 'st-a', type: 'sacafranco', startTime: '07:00', endTime: '19:00', platoonOffset: 4, sortOrder: 100, deletedAt: null },
          { id: 'sfB', tenantId: TENANT, stationId: 'st-b', type: 'sacafranco', startTime: '07:00', endTime: '19:00', platoonOffset: 4, sortOrder: 101, deletedAt: null },
        ],
      });
    }

    it('los 2 SF cubren, día a día en dse 4..7, los gaps de día de AMBAS estaciones (uno cada uno)', async () => {
      const db = seed();
      const covered = ['st-a', 'st-b'];
      const sf0 = await computeShiftsForAssignment(db, assignment({ id: 'sfA', positionId: 'sfA', stationId: 'st-a', isRelief: true, platoonOffset: 4, coveredStationIds: covered, endDate: '2024-01-10' }), TENANT);
      const sf1 = await computeShiftsForAssignment(db, assignment({ id: 'sfB', positionId: 'sfB', stationId: 'st-b', isRelief: true, platoonOffset: 4, coveredStationIds: covered, endDate: '2024-01-10' }), TENANT);

      // En dse 4..7 (bloque de día del SF), cada estación tiene un gap de día.
      // Entre los dos SF, ambas estaciones quedan cubiertas cada día, sin choque.
      for (const dse of [4, 5, 6, 7]) {
        const covThisDay = [...sf0, ...sf1].filter((s) => dseOf(s.startTime) === dse && s.shiftType === 'day');
        const stations = covThisDay.map((s) => s.stationId).sort();
        assert.deepStrictEqual(stations, ['st-a', 'st-b'], `dse ${dse}: ambas estaciones deben cubrirse (una por SF); got ${JSON.stringify(stations)}`);
      }

      // Ningún SF se duplica en la misma estación/día (reparto por índice, no choque).
      for (const set of [sf0, sf1]) {
        const keys = set.map((s) => `${dseOf(s.startTime)}|${s.stationId}`);
        assert.strictEqual(new Set(keys).size, keys.length, `un SF no debe cubrir dos veces el mismo día/estación: ${JSON.stringify(keys)}`);
      }
    });
  });

  // ── Sonda de invariante: SF sin descanso (restDays=0) rompe la secuencia ────
  //
  // La afirmación "el SF nunca hace noche→día a la mañana siguiente" está
  // GARANTIZADA por el descanso del ciclo 4-4-2 (el bloque de descanso separa el
  // último turno de noche del primer día del siguiente ciclo). Este caso prueba
  // qué pasa si se configura un SF con restDays=0 (rotación 1-1-0, día/noche
  // alternos sin descanso): el motor NO defiende la invariante — la sigue de la
  // rotación, así que emitiría noche→día. Documenta el límite del contrato.
  describe('sonda · SF con restDays=0 (rotación irreal por configuración)', () => {
    function seed() {
      return buildDb({
        tenant: [{ id: TENANT, timezone: TZ }],
        rotationStyle: [RS442, RS_1_1_0],
        station: [
          // Estación 24h con UN solo fijo ⇒ gaps continuos día y noche (para que
          // el SF siempre encuentre un gap de la mitad que le toca).
          { id: 'st-solo', tenantId: TENANT, scheduleType: '24h', rotationStyleId: 'rs-442', postSiteId: 'ps-1' },
          { id: 'st-sfhome', tenantId: TENANT, scheduleType: '24h', rotationStyleId: 'rs-110', postSiteId: 'ps-1' },
        ],
        stationPosition: [
          { id: 'fsolo', tenantId: TENANT, stationId: 'st-solo', type: 'fijo', startTime: '07:00', endTime: '19:00', platoonOffset: 0, sortOrder: 0, deletedAt: null },
          { id: 'sfBad', tenantId: TENANT, stationId: 'st-sfhome', type: 'sacafranco', startTime: '07:00', endTime: '19:00', platoonOffset: 0, sortOrder: 100, deletedAt: null },
        ],
      });
    }

    it('DOCUMENTA: un SF restDays=0 puede emitir noche→día a la mañana siguiente (invariante NO defendida por el motor)', async () => {
      const db = seed();
      const sf = await computeShiftsForAssignment(
        db,
        assignment({ id: 'sfBad', positionId: 'sfBad', stationId: 'st-sfhome', isRelief: true, platoonOffset: 0, coveredStationIds: ['st-solo'], endDate: '2024-01-14' }),
        TENANT,
      );
      const typeByDate = new Map<string, string>();
      for (const s of sf) typeByDate.set(dateOf(s.startTime), s.shiftType);

      let irrealFound = false;
      for (const [date, type] of typeByDate) {
        if (type !== 'night') continue;
        const next = new Date(`${date}T00:00:00Z`);
        next.setUTCDate(next.getUTCDate() + 1);
        if (typeByDate.get(next.toISOString().slice(0, 10)) === 'day') irrealFound = true;
      }
      // Este test NO impone la invariante: registra el comportamiento actual del
      // motor. Si algún día se defiende (validando la rotación del SF), esto
      // cambiará a false y habrá que actualizar la nota.
      assert.strictEqual(
        irrealFound,
        true,
        'Se esperaba (según el modelo actual) que un SF restDays=0 produjera un turno irreal noche→día. Si ahora NO lo produce, el motor ganó una defensa: actualiza esta sonda.',
      );
    });
  });
});
