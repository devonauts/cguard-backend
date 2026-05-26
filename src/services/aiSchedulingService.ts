/**
 * AI Scheduling Advisor Service
 * Uses OpenAI to provide intelligent scheduling recommendations.
 */

const OPENAI_BASE_URL = 'https://api.openai.com/v1';

interface StationContext {
  stationName: string;
  scheduleType: string; // '24h' | '12h-day' | '12h-night'
  currentRotation?: string;
  fijoCount: number;
  currentGuards: number;
}

interface SchedulingContext {
  totalStations: number;
  totalFijos: number;
  totalSacafrancos: number;
  currentGuards: number;
  stations: StationContext[];
  peakDemand: number;
  laborRegulations: string;
}

async function callGrok(systemPrompt: string, userMessage: string): Promise<string> {
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
      temperature: 0.3,
      max_tokens: 1500,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`OpenAI API error: ${response.status} - ${err}`);
  }

  const data: any = await response.json();
  return data.choices?.[0]?.message?.content || '';
}

const SYSTEM_PROMPT = `You are a security company scheduling expert for Ecuador. You help optimize guard schedules following these regulations:
- Jornada máxima: 8 hours/day, 40 hours/week
- Descanso obligatorio: minimum 2 consecutive rest days per week (for 12H rotations) or as configured
- Guards must not exceed 160 hours/month
- Night shifts (19:00-07:00) have 25% surcharge
- Weekend/holiday shifts have 100% surcharge
- The company wants to MINIMIZE costs while maintaining full coverage

Rotation styles available:
- 5-2 (5 days work, 2 rest) — standard for 12H stations, efficient
- 6-1 (6 days work, 1 rest) — maximum coverage per guard, used for sacafrancos
- 4-2 (4 days work, 2 rest) — less overtime, better quality of life
- 4-4-2 (4 day, 4 night, 2 rest) — standard for 24H stations
- 3-3-2 (3 day, 3 night, 2 rest) — shorter cycle, more frequent rotation
- 2-2-2 (2 day, 2 night, 2 rest) — fastest rotation, less fatigue

Key terms:
- Fijo: fixed guard assigned to one station
- Sacafranco: relief guard that covers fijos during rest days (floats between stations)
- platoonOffset: staggering so guards don't all rest on the same day

Always respond in Spanish. Be concise and actionable. Format recommendations as bullet points.`;

/**
 * Get AI recommendation for a new station setup
 */
export async function getStationRecommendation(
  stationName: string,
  scheduleType: string,
  context: SchedulingContext,
): Promise<{ recommendation: string; suggestedRotation: string; guardsNeeded: number }> {
  const prompt = `Nueva estación a configurar:
- Nombre: ${stationName}
- Tipo: ${scheduleType}

Contexto actual de la empresa:
- ${context.totalStations} estaciones activas
- ${context.totalFijos} posiciones fijo, ${context.totalSacafrancos} sacafrancos
- ${context.currentGuards} guardias contratados
- Demanda pico actual: ${context.peakDemand} estaciones necesitan cobertura simultánea

Pregunta: ¿Cuál es la mejor rotación para esta estación? ¿Cuántos guardias nuevos necesito contratar? ¿Los sacafrancos actuales pueden absorber esta estación o necesito más?

Responde con:
1. Rotación recomendada (nombre exacto: "5-2", "4-4-2", etc.)
2. Guardias fijos necesarios para esta estación
3. Si se necesitan sacafrancos adicionales
4. Costo estimado mensual adicional (asume $500 USD/guardia/mes base)`;

  const response = await callGrok(SYSTEM_PROMPT, prompt);

  // Extract suggested rotation from response
  const rotationMatch = response.match(/(?:rotación|recomendada)[:\s]*["']?(\d-\d(?:-\d)?)/i) 
    || response.match(/["'](\d-\d(?:-\d)?)["']/);
  const suggestedRotation = rotationMatch?.[1] || (scheduleType === '24h' ? '4-4-2' : '5-2');

  // Extract guards needed
  const guardsMatch = response.match(/(\d+)\s*(?:guardias?|fijos?)\s*(?:necesarios?|nuevos?|adicionales?)/i);
  const guardsNeeded = guardsMatch ? parseInt(guardsMatch[1]) : (scheduleType === '24h' ? 2 : 1);

  return { recommendation: response, suggestedRotation, guardsNeeded };
}

/**
 * Get AI optimization suggestions for the entire schedule
 */
export async function getScheduleOptimization(context: SchedulingContext): Promise<string> {
  const stationsSummary = context.stations.slice(0, 20).map(s => 
    `  - ${s.stationName}: ${s.scheduleType}, rotación ${s.currentRotation || 'sin configurar'}, ${s.currentGuards}/${s.fijoCount} guardias`
  ).join('\n');

  const prompt = `Analiza este horario y sugiere optimizaciones para reducir costos:

Resumen:
- ${context.totalStations} estaciones
- ${context.totalFijos} fijos necesarios, ${context.totalSacafrancos} sacafrancos necesarios
- ${context.currentGuards} guardias contratados actualmente
- Demanda pico: ${context.peakDemand} estaciones simultáneas

Estaciones (primeras 20):
${stationsSummary}

Sugiere:
1. ¿Se pueden consolidar estaciones?
2. ¿Hay rotaciones más eficientes?
3. ¿Cuántos guardias se pueden ahorrar con mejor staggering?
4. ¿Estimado de ahorro mensual?`;

  return callGrok(SYSTEM_PROMPT, prompt);
}

/**
 * Quick recommendation for which rotation to use
 */
export async function getRotationAdvice(scheduleType: string, numPositions: number): Promise<string> {
  const prompt = `Para una estación ${scheduleType} con ${numPositions} posiciones fijo, ¿cuál rotación recomiendas y por qué? Responde en 2-3 oraciones máximo.`;
  return callGrok(SYSTEM_PROMPT, prompt);
}
