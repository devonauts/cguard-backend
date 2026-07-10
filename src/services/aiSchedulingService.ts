/**
 * AI Scheduling Advisor Service
 * Uses OpenAI (GPT-4o-mini) with deep system knowledge to provide
 * intelligent scheduling recommendations based on the actual algorithm.
 */

const OPENAI_BASE_URL = 'https://api.openai.com/v1';

interface StationContext {
  stationName: string;
  scheduleType: string; // '24h' | '12h-day' | '12h-night'
  currentRotation?: string;
  fijoCount: number;
  currentGuards: number;
  platoonOffset?: number;
  restDaysStart?: number; // Which day of the cycle rest starts (0=Mon from epoch)
}

interface SchedulingContext {
  totalStations: number;
  totalFijos: number;
  totalSacafrancos: number;
  currentGuards: number;
  stations: StationContext[];
  peakDemand: number;
  laborRegulations: string;
  dailyDemand?: number[]; // Array of how many stations need coverage each day of the cycle
  sfUtilization?: number; // Percentage of SF work days actually covering vs idle
}

// Hard timeout for the OpenAI call. This runs inside Express request handlers,
// so a hung upstream would otherwise hold the connection (and its DB pool slot)
// indefinitely. On abort, fetch rejects and safeCallAI returns the standard
// Spanish unavailable message.
const OPENAI_TIMEOUT_MS = 30_000;

async function callAI(systemPrompt: string, userMessage: string, maxTokens = 2000): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY not configured');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OPENAI_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(`${OPENAI_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
        temperature: 0.4,
        max_tokens: maxTokens,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`OpenAI API error: ${response.status} - ${err}`);
    }

    const data: any = await response.json();
    return data.choices?.[0]?.message?.content || '';
  } catch (e: any) {
    if (e?.name === 'AbortError' || controller.signal.aborted) {
      throw new Error(`OpenAI API timeout after ${OPENAI_TIMEOUT_MS}ms`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** True when the AI advisor can be called. */
export function isAiConfigured(): boolean {
  return !!process.env.OPENAI_API_KEY;
}

const AI_UNAVAILABLE_ES =
  'El asesor de IA no está disponible en este momento (falta configurar OPENAI_API_KEY o hubo un error de conexión con OpenAI). ' +
  'Esto NO afecta el horario: el motor determinístico “Optimizar sacafrancos” sigue funcionando y es la fuente de verdad. ' +
  'Vuelve a intentarlo más tarde o pide al administrador que configure la clave de OpenAI.';

/** Call the AI but never throw — return a clear Spanish message on any failure
 *  (missing key, network, rate-limit) so the feature degrades gracefully. */
async function safeCallAI(systemPrompt: string, userMessage: string, maxTokens = 2000): Promise<string> {
  try {
    return await callAI(systemPrompt, userMessage, maxTokens);
  } catch (e: any) {
    console.warn('[aiScheduling] advisor unavailable:', e?.message || e);
    return AI_UNAVAILABLE_ES;
  }
}

/**
 * Deep system knowledge prompt — teaches the AI exactly how our scheduling engine works
 * so it can reason mathematically and suggest true optimizations.
 */
const SYSTEM_PROMPT = `You are an expert scheduling optimization AI for "CGuard Pro", a security guard management system deployed in Ecuador. You have DEEP, ACCURATE knowledge of how the system's scheduling engine actually works (described below) and reason about it precisely. NEVER invent rules that contradict this model.

## SYSTEM ARCHITECTURE (current engine)

### Fixed Epoch
All rotations are anchored to a FIXED epoch (January 1, 2024) — it does NOT move each year. Rotation status for a guard on day D:
\`\`\`
adjustedDay = ((daysSinceEpoch - platoonOffset) mod cycleLength + cycleLength) mod cycleLength
adjustedDay < dayShifts                      → DAY shift (work)
adjustedDay < dayShifts + nightShifts        → NIGHT shift (work)
otherwise                                    → REST
\`\`\`

### Everything runs on a 10-DAY CYCLE so all stations + sacafrancos SYNC
- **24h station** → rotation **4-4-2** (4 day, 4 night, 2 rest; cycle 10). It has TWO fijos, STAGGERED by dayShifts (offset and offset−4) so when one fijo is on its DAY block the other is on its NIGHT block — they swap day/night each cycle and together cover most of the 24h. Each fijo rests 2 days per cycle.
- **12h-day** / **12h-night** station → rotation **8-2** (8 work, 2 rest, single shift; cycle 10). One fijo; rests 2 days per cycle. (NOT 5-2 — a 7-day cycle would not sync with the 10-day SF.)
- Every guard therefore rests exactly **2 days per 10-day cycle**.

### Gaps
When a fijo rests, its shift half (DAY 07:00–19:00 or NIGHT 19:00–07:00) is uncovered → a "gap". A 24h station yields 2 day-gaps + 2 night-gaps per cycle; a 12h-day station 2 day-gaps; a 12h-night station 2 night-gaps.

### Sacafranco (SF) — GLOBAL relief on a real 4-4-2
- An SF is GLOBAL: shared across ALL post sites and stations; it goes wherever a fijo is resting.
- An SF runs **4-4-2**: it works its DAY block (4 days) covering DAY gaps, then its NIGHT block (4 days) covering NIGHT gaps, then RESTS 2 days. Pattern: D D D D N N N N L L.
- FEASIBILITY RULE (critical): an SF can NEVER work a night then a day the next morning (a night ends 07:00, a day starts 07:00 — no rest). Following 4-4-2 strictly guarantees feasible transitions (day→night→rest→day only).
- So one SF provides **4 day-slots + 4 night-slots per cycle** → it can cover the rest days of ~4 guards (e.g. 2 day-resting + 2 night-resting).

### The Planner (planStationsAndSf) — how offsets are chosen
The engine chooses each fijo's offset AND the single shared SF offset together so that EVERY day-gap lands inside the SF's day-block and EVERY night-gap inside its night-block (no "out-of-block" gaps). Then:
\`\`\`
SF count (N) = peak per-block load = max over the cycle of (day-gaps on a day-block day, night-gaps on a night-block day)
\`\`\`
When N>1, the SFs share the offset and SPLIT each day's same-half gaps by index. Goal: FEWEST sacafrancos that fully cover, with a feasible day→night→rest schedule.

### Coverage truth
A schedule is valid only if EVERY (station, day, half it requires) has exactly 1 guard. 0 = gap (uncovered post), >1 = overstaff (wasted). This is checked from the real generated shifts.

### Rotation styles (cycle = day + night + rest)
| Name  | Day | Night | Rest | Cycle | Used for |
|-------|-----|-------|------|-------|----------|
| 4-4-2 | 4   | 4     | 2    | 10    | 24H stations (fijos swap D/N) AND sacafrancos |
| 8-2   | 8   | 0     | 2    | 10    | 12H stations (single shift) |
| 4-2 / 3-3-2 / 2-2-2 / 6-1 / 5-2 | … | | | 6–10 | available, but NON-10-day cycles break sync with the SF — avoid mixing |

### Ecuador labor context
- Night surcharge +25% (19:00–07:00); Sunday/holiday surcharge; vacations 15 days/yr after 1 year.
- The 4-4-2 / 8-2 cadence implies up to 8 consecutive workdays then 2 rest. If stricter consecutive-day limits are required, more SFs/guards are needed — flag this when relevant.

### Cost (approx, Ecuador 2025–2026): loaded cost ~$700–800/month per guard. An SF is efficient because one SF relieves ~4 guards' rest days.

## YOUR CAPABILITIES
1. Verify if the current setup is optimal (right rotations per type, fewest SFs, full coverage, feasible SF schedule).
2. Detect anomalies: stations on a non-10-day rotation (won't sync), 24H stations with <2 fijos, under/over-staffing.
3. What-if & growth planning: estimate SFs/guards when adding stations (≈ one SF per ~4 guards' rest days, exact via the block model).
4. Flag infeasible or labor-risky configurations.

## RESPONSE FORMAT
Always respond in Spanish, precise with numbers, BEFORE → AFTER when proposing changes. Structure:
1. **Diagnóstico** — current state + problems
2. **Recomendación** — specific actionable changes
3. **Impacto** — quantified effect (SF/guard count, coverage, cost)
4. **Riesgos** — trade-offs`;

/**
 * Get AI recommendation for a new station setup
 */
export async function getStationRecommendation(
  stationName: string,
  scheduleType: string,
  context: SchedulingContext,
): Promise<{ recommendation: string; suggestedRotation: string; guardsNeeded: number }> {
  const prompt = `NUEVA ESTACIÓN A CONFIGURAR:
- Nombre: "${stationName}"
- Tipo de horario: ${scheduleType}

CONTEXTO ACTUAL DEL SISTEMA:
- ${context.totalStations} estaciones activas (ya optimizadas con offsets secuenciales)
- ${context.totalFijos} posiciones fijo totales
- ${context.totalSacafrancos} sacafrancos activos
- ${context.currentGuards} guardias contratados
- Demanda pico: ${context.peakDemand} estaciones necesitan cobertura simultánea
${context.dailyDemand ? `- Distribución diaria de demanda SF: [${context.dailyDemand.join(', ')}]` : ''}

PREGUNTA COMPUESTA:
1. ¿Cuál rotación es óptima para "${stationName}" (${scheduleType})?
2. ¿Cuántos guardias fijos necesita?
3. Con los ${context.totalSacafrancos} SFs actuales, ¿pueden absorber esta nueva estación o se necesitan más?
4. ¿Cuál sería el nuevo peakDemand si agregamos esta estación?
5. Costo mensual incremental estimado.

IMPORTANTE: Razona con el modelo REAL del sistema (ciclo de 10 días, todo sincronizado):
- 24h → 4-4-2 con 2 fijos; 12h → 8-2 con 1 fijo. Cada guardia descansa 2 días por ciclo.
- Esta estación añade gaps: un 24h = 2 de día + 2 de noche; 12h-day = 2 de día; 12h-night = 2 de noche.
- Un sacafranco (4-4-2) aporta 4 cupos de día + 4 de noche por ciclo (≈ los descansos de 4 guardias). Estima SFs adicionales según cuántos gaps de día/noche por día se sumen al bloque del SF.`;

  const response = await safeCallAI(SYSTEM_PROMPT, prompt);

  // Extract suggested rotation from response
  const rotationMatch = response.match(/(?:rotación|recomendada|óptima)[:\s]*["']?(\d-\d(?:-\d)?)/i)
    || response.match(/(\d-\d(?:-\d)?)\s*(?:es|sería|como)\s*(?:la\s+)?(?:mejor|óptima|recomendada)/i)
    || response.match(/["'](\d-\d(?:-\d)?)["']/);
  const suggestedRotation = rotationMatch?.[1] || (scheduleType === '24h' ? '4-4-2' : '8-2');

  // Extract guards needed
  const guardsMatch = response.match(/(\d+)\s*(?:guardias?|fijos?)\s*(?:necesarios?|nuevos?|adicionales?|fijos?)/i)
    || response.match(/(?:necesita|requiere)\s*(\d+)\s*(?:guardias?|fijos?)/i);
  const guardsNeeded = guardsMatch ? parseInt(guardsMatch[1]) : (scheduleType === '24h' ? 2 : 1);

  return { recommendation: response, suggestedRotation, guardsNeeded };
}

/**
 * Get AI optimization suggestions for the entire schedule
 */
export async function getScheduleOptimization(context: SchedulingContext): Promise<string> {
  const stationsSummary = context.stations.slice(0, 30).map(s =>
    `  - ${s.stationName}: ${s.scheduleType}, rot=${s.currentRotation || '?'}, fijos=${s.fijoCount}, offset=${s.platoonOffset ?? '?'}, restStart=day${s.restDaysStart ?? '?'}`
  ).join('\n');

  const prompt = `ANÁLISIS COMPLETO DEL SISTEMA DE HORARIOS:

MÉTRICAS ACTUALES:
- Estaciones: ${context.totalStations}
- Fijos totales: ${context.totalFijos}
- Sacafrancos: ${context.totalSacafrancos}
- Guardias contratados: ${context.currentGuards}
- Demanda pico: ${context.peakDemand} estaciones/día
${context.dailyDemand ? `- Distribución demanda diaria: [${context.dailyDemand.slice(0, 14).join(', ')}...]` : ''}
${context.sfUtilization ? `- Utilización SF: ${context.sfUtilization}% (días trabajando vs capacidad total)` : ''}

DETALLE ESTACIONES (primeras 30):
${stationsSummary}

ANÁLISIS SOLICITADO (usa el modelo real: ciclo de 10 días, todo sincronizado):
1. **Sincronización de rotaciones**: ¿Toda estación 24h usa 4-4-2 (2 fijos) y toda 12h usa 8-2 (1 fijo)? Marca como problema cualquier estación en una rotación de ciclo ≠ 10 (p.ej. 5-2, 6-1) porque ROMPE la sincronía con el sacafranco.
2. **Cobertura de fijos**: ¿Hay estaciones 24h con menos de 2 fijos, o posiciones fijo sin guardia asignado? Esos puestos quedan sin cubrir.
3. **Dimensionamiento de SF**: ${context.totalSacafrancos} SFs actuales. Un SF (4-4-2) cubre ≈ los descansos de 4 guardias (4 cupos día + 4 noche por ciclo). ¿Es suficiente, sobra o falta? Recuerda: un SF nunca puede hacer noche y luego día al día siguiente.
4. **Contrataciones**: faltante aproximado = fijos + SFs - contratados = ${context.totalFijos + context.totalSacafrancos - context.currentGuards}.
5. **Score general**: 1-10 en sincronización, cobertura y bienestar.

RESPONDE con diagnóstico preciso y recomendaciones numeradas con impacto cuantificado.`;

  return safeCallAI(SYSTEM_PROMPT, prompt, 3000);
}

/**
 * Quick recommendation for which rotation to use
 */
export async function getRotationAdvice(scheduleType: string, numPositions: number): Promise<string> {
  const prompt = `CONSULTA RÁPIDA:
Estación tipo "${scheduleType}" con ${numPositions} posiciones fijo.

Usando el modelo real (ciclo de 10 días, todo sincronizado con el sacafranco):
- 24H → 4-4-2 (cycle 10), con 2 fijos escalonados (uno cubre día mientras el otro cubre noche, alternan).
- 12H → 8-2 (cycle 10, turno único). NO usar 5-2 (ciclo 7) porque rompe la sincronía.

¿Cuál es la rotación óptima y por qué? ¿Cuántos SFs adicionales genera esta configuración (un SF 4-4-2 cubre ≈ los descansos de 4 guardias)?
Responde en 3-4 oraciones máximo con números exactos.`;

  return safeCallAI(SYSTEM_PROMPT, prompt, 500);
}

/**
 * Advanced: Ask the AI to analyze a specific scheduling problem or scenario
 */
export async function analyzeScenario(
  question: string,
  context: SchedulingContext,
): Promise<string> {
  const prompt = `CONTEXTO DEL SISTEMA:
- ${context.totalStations} estaciones, ${context.totalFijos} fijos, ${context.totalSacafrancos} SFs
- ${context.currentGuards} guardias contratados
- Peak demand: ${context.peakDemand}
- Modelo: ciclo de 10 días, epoch fijo (1 ene 2024); 24h=4-4-2, 12h=8-2; sacafranco 4-4-2 global (día→noche→libre)
${context.dailyDemand ? `- Demanda diaria: [${context.dailyDemand.join(', ')}]` : ''}

PREGUNTA DEL USUARIO:
${question}

Responde usando tu conocimiento del modelo matemático del sistema. Sé preciso con cálculos. Si la pregunta implica un cambio, muestra el impacto ANTES → DESPUÉS.`;

  return safeCallAI(SYSTEM_PROMPT, prompt, 2500);
}

