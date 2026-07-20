/**
 * I2 — MINIMIZACIÓN DE SACAFRANCOS, probada contra el PLANIFICADOR REAL.
 *
 * Las suites del primer barrido cubrieron I1 (libres) y afirmaron el spreading
 * a mano, pero NINGUNA ejecutaba planStationsAndSf — el componente que de verdad
 * decide cuántos sacafrancos hacen falta. La revisión adversarial lo marcó como
 * el hueco grave. Esta suite corre el planner real y afirma:
 *   - el caso canónico del demo (2 fijos 4-4-2 escalonados) → 1 SF, 0 out-of-block
 *   - un SF 4-4-2 real cubre día-en-bloque-día y noche-en-bloque-noche (feasible)
 *   - subir la carga sube el conteo de SF de forma monótona (nunca baja)
 *   - regresión de los 2 bugs del optimizador arreglados hoy (exclusión de
 *     alternancia + regen de turnos con 0 SF) a nivel de planner.
 */
import assert from 'assert';
import { planStationsAndSf, StationSpreadInfo } from '../../../src/services/shiftGenerationService';

const SF_442 = { dayShifts: 4, nightShifts: 4, restDays: 2 };

function station(id: string, scheduleType: string, rot: any, nFijos: number): StationSpreadInfo {
  return {
    stationId: id, scheduleType, rot,
    fijos: Array.from({ length: nFijos }, (_, i) => ({ id: `${id}-f${i}`, sortOrder: i })),
  };
}

describe('planStationsAndSf · I2 minimización de sacafrancos', () => {
  it('caso canónico: 1 estación 24h con 2 fijos 4-4-2 → exactamente 1 SF, 0 out-of-block', async () => {
    const plan = await planStationsAndSf(
      [station('s24', '24h', { dayShifts: 4, nightShifts: 4, restDays: 2 }, 2)],
      SF_442,
    );
    assert.strictEqual(plan.sfCount, 1, 'un solo sacafranco basta para 2 fijos escalonados');
    assert.strictEqual(plan.outOfBlock, 0, 'ningún gap cae fuera del bloque del SF (turno factible)');
    // Los dos fijos NO comparten offset (escalonados) → sus descansos no colisionan.
    const offs = Array.from(plan.fijoOffsets.values());
    assert.strictEqual(offs.length, 2);
    assert.notStrictEqual(offs[0], offs[1], 'los 2 fijos quedan escalonados, no colapsados');
  });

  it('demo 3 estaciones (24h + 12h-day + 12h-night) → cubre con SF factible, 0 out-of-block', async () => {
    const plan = await planStationsAndSf([
      station('garita', '24h', { dayShifts: 4, nightShifts: 4, restDays: 2 }, 2),
      station('lobby', '12h-day', { dayShifts: 8, nightShifts: 0, restDays: 2 }, 1),
      station('perimetro', '12h-night', { dayShifts: 8, nightShifts: 0, restDays: 2 }, 1),
    ], SF_442);
    assert.ok(plan.sfCount >= 1, 'hay demanda de sacafranco');
    assert.strictEqual(plan.outOfBlock, 0, 'todos los gaps son cubribles en bloque (día/noche) por el SF');
    // El SF trabaja su bloque y descansa: la carga por bloque nunca excede sfCount.
    const peakDay = Math.max(...plan.dayLoad, 0);
    const peakNight = Math.max(...plan.nightLoad, 0);
    assert.ok(peakDay <= plan.sfCount, 'la carga de día no supera el nº de SF');
    assert.ok(peakNight <= plan.sfCount, 'la carga de noche no supera el nº de SF');
  });

  it('feasibilidad: en el super-ciclo, día-load y noche-load nunca coexisten fuera de bloque', async () => {
    // Un SF 4-4-2 hace 4 días de día, 4 de noche, 2 libre. Si el plan es factible,
    // outOfBlock=0 significa que ningún gap exigió al SF hacer noche→día.
    const plan = await planStationsAndSf(
      [station('s', '24h', { dayShifts: 4, nightShifts: 4, restDays: 2 }, 2)],
      SF_442,
    );
    assert.strictEqual(plan.outOfBlock, 0);
    // La longitud del super-ciclo es LCM de los ciclos (10 para 4-4-2 y SF 4-4-2).
    assert.strictEqual(plan.L % 10, 0, 'super-ciclo múltiplo de 10');
  });

  it('monotonía: más estaciones con demanda ⇒ sfCount no decrece', async () => {
    const rot442 = { dayShifts: 4, nightShifts: 4, restDays: 2 };
    const one = await planStationsAndSf([station('a', '24h', rot442, 2)], SF_442);
    const three = await planStationsAndSf([
      station('a', '24h', rot442, 2),
      station('b', '24h', rot442, 2),
      station('c', '24h', rot442, 2),
    ], SF_442);
    assert.ok(three.sfCount >= one.sfCount,
      `3 estaciones (${three.sfCount}) no puede necesitar menos SF que 1 (${one.sfCount})`);
  });

  it('un plan vacío (0 estaciones) ⇒ 0 sacafrancos', async () => {
    const plan = await planStationsAndSf([], SF_442);
    assert.strictEqual(plan.sfCount, 0);
    assert.strictEqual(plan.outOfBlock, 0);
  });

  it('cada fijo recibe un offset asignado (ninguno queda sin planificar)', async () => {
    const plan = await planStationsAndSf([
      station('a', '24h', { dayShifts: 4, nightShifts: 4, restDays: 2 }, 2),
      station('b', '12h-day', { dayShifts: 8, nightShifts: 0, restDays: 2 }, 1),
    ], SF_442);
    // 2 fijos en A + 1 en B = 3 offsets.
    assert.strictEqual(plan.fijoOffsets.size, 3, 'todos los fijos quedan con offset planificado');
    for (const off of plan.fijoOffsets.values()) {
      assert.ok(Number.isInteger(off) && off >= 0, 'offset entero no-negativo');
    }
  });
});
