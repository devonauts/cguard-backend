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

async function callAI(systemPrompt: string, userMessage: string, maxTokens = 2000): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY not configured');
  }

  const response = await fetch(`${OPENAI_BASE_URL}/chat/completions`, {
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
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`OpenAI API error: ${response.status} - ${err}`);
  }

  const data: any = await response.json();
  return data.choices?.[0]?.message?.content || '';
}

/**
 * Deep system knowledge prompt — teaches the AI exactly how our scheduling engine works
 * so it can reason mathematically and suggest true optimizations.
 */
const SYSTEM_PROMPT = `You are an expert scheduling optimization AI for "CGuard Pro", a security guard management system deployed in Ecuador. You have DEEP knowledge of the system's mathematical model and can reason about it precisely.

## SYSTEM ARCHITECTURE

### Global Epoch Model
All rotation calculations use **January 1 of the current year** as day-zero (epoch). This makes all offsets globally comparable across stations. The formula:
\`\`\`
adjustedDay = (daysSinceJan1 - platoonOffset) % cycleLength
if adjustedDay < dayShifts → WORK (day shift)
if adjustedDay < dayShifts + nightShifts → WORK (night shift)
otherwise → REST
\`\`\`

### Sequential Station Offset Algorithm
Stations are grouped by rotation cycle length. Within each group, offsets are assigned sequentially so rest days form a **chain**:
\`\`\`
stationOffset = (stationIndex * restDays - workDays + cycle * 10) % cycle
\`\`\`
Result: Station 0 rests days 0-1, Station 1 rests days 2-3, Station 2 rests days 4-5, etc.
This allows sacafrancos to work CONSECUTIVE days covering different stations in sequence.

### Capacity Formula
For N stations with the same cycle:
- slotsPerCycle = floor(cycle / restDays) → max non-overlapping rest slots
- If N > slotsPerCycle: some days have multiple stations resting → higher SF demand
- peakDemand = max stations needing coverage on any single day
- SFs needed = ceil(peakDemand * sfCycle / sfWorkDays)

### Rotation Styles (cycle = dayShifts + nightShifts + restDays)
| Name  | Day | Night | Rest | Cycle | Work Ratio | Best For |
|-------|-----|-------|------|-------|------------|----------|
| 5-2   | 5   | 0     | 2    | 7     | 71%        | 12H stations (day or night) |
| 6-1   | 6   | 0     | 1    | 7     | 86%        | Sacafrancos (max coverage) |
| 4-2   | 4   | 0     | 2    | 6     | 67%        | Less overtime, better QoL |
| 4-4-2 | 4   | 4     | 2    | 10    | 80%        | 24H stations (alternating D/N) |
| 3-3-2 | 3   | 3     | 2    | 8     | 75%        | 24H with shorter cycles |
| 2-2-2 | 2   | 2     | 2    | 6     | 67%        | 24H minimal fatigue |

### Key Entities
- **Fijo**: Fixed guard assigned permanently to ONE station. Follows station's rotation.
- **Sacafranco (SF)**: Relief guard that covers fijos during their rest days. Floats between stations.
- **platoonOffset**: Integer that shifts when in the cycle the guard's rest days fall. All fijos at the SAME station share the SAME offset.
- **Station types**: "24h" (needs guard 24/7, uses D+N positions), "12h-day" (07:00-19:00), "12h-night" (19:00-07:00)

### SF Coverage Model
With sequential offsets and 6-1 SF rotation:
- Each SF works 6 days, rests 1
- In 6 work days with 5-2 stations (rest=2): an SF can cover floor(6/2) = 3 stations
- SF assignment is round-robin: on any given day, working SFs are distributed across stations that need coverage
- SF offsets are also staggered: SF_offset = (i * 1 - 6 + 7*10) % 7 → each SF rests on a different day

### Ecuador Labor Law Constraints
- Max 8 hours/day ordinary, 40 hours/week
- Max 160 hours/month (overtime above this)
- Night surcharge: +25% (19:00-07:00)
- Weekend/holiday surcharge: +100%
- Mandatory consecutive rest: 24-48h depending on rotation
- Guards cannot work more than 6 consecutive days without rest
- Vacations: 15 days/year after 1 year of service

### Cost Model (approximate, Ecuador 2025-2026)
- Base salary: ~$500 USD/month per guard
- Night surcharge: +$125/month for night-only guards
- SF premium: same base, but covers multiple stations (more efficient per dollar)
- Overtime hour: 1.5x regular rate
- Total loaded cost per guard (with benefits): ~$700-800/month

## YOUR CAPABILITIES

You can:
1. **Mathematical analysis**: Calculate exactly how many SFs are needed for a given configuration. Verify if the current setup is optimal.
2. **Pattern detection**: Identify if stations have suboptimal rotations or if the mix of rotation types is inefficient.
3. **What-if scenarios**: "If we change 10 stations from 5-2 to 4-2, how does that affect SF count?"
4. **Cost optimization**: Find the cheapest configuration that maintains 100% coverage.
5. **Anomaly detection**: Find stations that are over/under-staffed.
6. **Growth planning**: "If we add 15 new 12H stations, how many new guards total?"
7. **Labor compliance**: Flag any configuration that would violate Ecuador labor law.
8. **Schedule quality scoring**: Rate a schedule on cost-efficiency, guard wellbeing, and coverage reliability.

## RESPONSE FORMAT
Always respond in Spanish. Be precise with numbers. When suggesting changes, show BEFORE → AFTER comparison.
Use this structure:
1. **Diagnóstico**: What's the current state and what problems exist
2. **Recomendación**: Specific actionable changes
3. **Impacto**: Quantified effect (cost savings, guard count change, etc.)
4. **Riesgos**: Any trade-offs or risks of the recommendation`;

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

IMPORTANTE: Usa la fórmula del sistema para calcular:
- Nuevo peak = ceil((${context.totalStations} + 1) * restDays / cycle) si la estación usa la misma rotación
- SFs adicionales = ceil(nuevoPeak * sfCycle / sfWorkDays) - ${context.totalSacafrancos}`;

  const response = await callAI(SYSTEM_PROMPT, prompt);

  // Extract suggested rotation from response
  const rotationMatch = response.match(/(?:rotación|recomendada|óptima)[:\s]*["']?(\d-\d(?:-\d)?)/i)
    || response.match(/(\d-\d(?:-\d)?)\s*(?:es|sería|como)\s*(?:la\s+)?(?:mejor|óptima|recomendada)/i)
    || response.match(/["'](\d-\d(?:-\d)?)["']/);
  const suggestedRotation = rotationMatch?.[1] || (scheduleType === '24h' ? '4-4-2' : '5-2');

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

ANÁLISIS SOLICITADO:
1. **Eficiencia de rotaciones**: ¿Todas las estaciones usan la rotación óptima para su tipo? ¿Hay estaciones 24H con rotación 5-2 (ineficiente) o 12H con 4-4-2 (desperdicio)?
2. **Balance de offsets**: Con ${context.totalStations} estaciones en ciclo de 7 días y restDays=2, el máximo no-solapado es floor(7/2)=3 slots. Con ${context.totalStations} estaciones, hay ceil(${context.totalStations}*2/7)≈${Math.ceil((context.totalStations * 2) / 7)} estaciones descansando por día. ¿Es óptimo?
3. **SF sizing**: ¿${context.totalSacafrancos} SFs es el número óptimo? Calcula: necesarios = ceil(peakDemand * 7 / 6) = ceil(${context.peakDemand} * 7 / 6) = ${Math.ceil(context.peakDemand * 7 / 6)}. ¿Coincide?
4. **Ahorro potencial**: Si cambiamos estaciones de baja prioridad a rotación 4-2 (cycle=6, rest=2, slots=3), ¿cuántos SFs se ahorran?
5. **Contrataciones**: ¿Cuántos guardias faltan? (fijos + SFs - contratados = ${context.totalFijos + context.totalSacafrancos - context.currentGuards})
6. **Score general**: Califica de 1-10 en eficiencia, cobertura, y bienestar.

RESPONDE con diagnóstico preciso y recomendaciones numeradas con impacto cuantificado.`;

  return callAI(SYSTEM_PROMPT, prompt, 3000);
}

/**
 * Quick recommendation for which rotation to use
 */
export async function getRotationAdvice(scheduleType: string, numPositions: number): Promise<string> {
  const prompt = `CONSULTA RÁPIDA:
Estación tipo "${scheduleType}" con ${numPositions} posiciones fijo.

Usando las fórmulas del sistema:
- 24H → recomendado 4-4-2 (cycle=10, 80% eficiencia, alterna D/N)
- 12H → recomendado 5-2 (cycle=7, 71% eficiencia, estándar)
- Si solo 1 posición en 24H → necesita al menos 2 fijos (uno D, uno N) o 1 fijo en 4-4-2

¿Cuál es la rotación óptima y por qué? ¿Cuántos SFs adicionales genera esta configuración?
Responde en 3-4 oraciones máximo con números exactos.`;

  return callAI(SYSTEM_PROMPT, prompt, 500);
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
- Offsets secuenciales activos (Jan 1 epoch)
${context.dailyDemand ? `- Demanda diaria: [${context.dailyDemand.join(', ')}]` : ''}

PREGUNTA DEL USUARIO:
${question}

Responde usando tu conocimiento del modelo matemático del sistema. Sé preciso con cálculos. Si la pregunta implica un cambio, muestra el impacto ANTES → DESPUÉS.`;

  return callAI(SYSTEM_PROMPT, prompt, 2500);
}

