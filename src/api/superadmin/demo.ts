/**
 * SuperAdmin · Demo Control routes.
 *
 * Mounted under /api/superadmin by ./index.ts, BEHIND requireSuperadmin — so
 * every handler can assume an authenticated platform superadmin caller. These
 * endpoints drive the live sales demo: sequential "Run Step" buttons + a Reset.
 *
 * HARD SAFETY: the orchestrator service resolves the demo tenant and asserts it
 * is the configured demo tenant (DEMO_TENANT_ID env, else the demo slug) before
 * ANY action. Nothing in the request body selects a tenant — the demo tenant is
 * always derived server-side, so a demo action can NEVER hit a real tenant.
 *
 * This module is the CONTRACT ADAPTER between the orchestrator service (rich,
 * internal shape) and the superadmin frontend's `DemoState` contract
 * (superadmin/src/services/demoControl.ts). The frontend reads state.available,
 * state.steps[].{title,description,done,ranAt}, and state.log[].
 *
 * Payloads are returned DIRECTLY (no { success, data } wrapper). Every mutation
 * writes a superadmin audit entry.
 */
import ApiResponseHandler from '../apiResponseHandler';
import { db, writeAudit } from '../../services/superadmin/superadminHelpers';
import {
  runStep,
  resetDemo,
  getState,
  getDemoLog,
  getLastResetAt,
  DEMO_STEPS,
} from '../../services/demo/demoOrchestratorService';

/** One-line description per step (shown under each step title in the stepper). */
const STEP_DESCRIPTIONS: Record<string, string> = {
  schedule:
    'El administrador publica los turnos Día y Noche de hoy. Notificación en vivo en el CRM.',
  clockin:
    'El guardia del turno Día marca entrada. Asistencia + notificación en vivo a admin y cliente.',
  visitor:
    'Se registra un visitante en la garita (control de visitas). Alerta en vivo a supervisores.',
  patrol:
    'El guardia escanea los puntos de ronda; uno queda omitido. Progreso + alerta de punto omitido.',
  incident:
    'El guardia reporta un incidente con foto. Alerta en vivo + escalamiento a supervisores y cliente.',
  radio: 'Se inicia un pase de novedades (roll call) a los guardias de turno.',
  handover:
    'Relevo de turno: el Día marca salida y el de Noche marca entrada. Notificación de relevo en vivo.',
};

/** Step list used when the demo tenant is not provisioned (available:false). */
const FALLBACK_STEPS = DEMO_STEPS.map((s) => ({
  step: s.step,
  title: s.label,
  description: STEP_DESCRIPTIONS[s.key] || '',
  done: false,
  ranAt: null,
}));

/**
 * Build the frontend `DemoState`. Never throws: if the demo tenant is not
 * seeded / not resolvable, returns { available:false } with 200 so the page can
 * render the "unavailable" notice gracefully (the GET uses silentError).
 */
async function buildState(database: any): Promise<any> {
  try {
    const s = await getState(database);
    const steps = s.steps.map((st: any) => ({
      step: st.step,
      title: st.label,
      description: STEP_DESCRIPTIONS[st.key] || '',
      done: s.currentStep >= st.step,
      ranAt: null,
    }));
    return {
      available: !!s.seeded,
      tenantId: s.tenant?.id,
      tenantName: s.tenant?.name,
      // currentStep = the NEXT step to run (1 fresh … totalSteps+1 when all done).
      currentStep: Math.min((s.currentStep || 0) + 1, steps.length + 1),
      totalSteps: steps.length,
      steps,
      accounts: s.accounts,
      site: s.site,
      stations: s.stations,
      liveCounts: s.liveCounts,
      lastResetAt: getLastResetAt(),
      log: getDemoLog(),
    };
  } catch (error: any) {
    return {
      available: false,
      currentStep: 1,
      totalSteps: FALLBACK_STEPS.length,
      steps: FALLBACK_STEPS,
      lastResetAt: getLastResetAt(),
      log: getDemoLog(),
      error: error?.message || 'Demo no disponible en este entorno.',
    };
  }
}

export default (router) => {
  // GET /superadmin/demo/state — full DemoState for the panel.
  router.get('/demo/state', async (req, res) => {
    try {
      await ApiResponseHandler.success(req, res, await buildState(db(req)));
    } catch (error) {
      await ApiResponseHandler.error(req, res, error);
    }
  });

  // POST /superadmin/demo/steps/:step/run  (step = 1..7)
  router.post('/demo/steps/:step/run', async (req, res) => {
    const step = parseInt(req.params.step, 10);
    try {
      const r = await runStep(db(req), step);
      await writeAudit(req, {
        action: 'demo.run-step',
        targetType: 'demoStep',
        targetId: String(step),
        tenantId: (r.details && r.details.tenantId) || null,
        statusCode: 200,
        details: { step: r.step, key: r.key, ok: r.ok, message: r.message },
      });
      const state = await buildState(db(req));
      const entry = {
        id: `s${r.step}-${r.at}`,
        at: r.at,
        step: r.step,
        level: r.ok ? 'success' : 'error',
        message: r.message,
        meta: r.details || null,
      };
      await ApiResponseHandler.success(req, res, { step: r.step, title: r.label, entries: [entry], state });
    } catch (error: any) {
      await writeAudit(req, {
        action: 'demo.run-step',
        targetType: 'demoStep',
        targetId: Number.isFinite(step) ? String(step) : null,
        statusCode: error?.code || 500,
        details: { error: error?.message || String(error) },
      });
      await ApiResponseHandler.error(req, res, error);
    }
  });

  // POST /superadmin/demo/reset — restore the clean seeded state.
  router.post('/demo/reset', async (req, res) => {
    try {
      const r = await resetDemo(db(req));
      await writeAudit(req, {
        action: 'demo.reset',
        targetType: 'demoTenant',
        statusCode: 200,
        details: { deleted: r.deleted },
      });
      const state = await buildState(db(req));
      await ApiResponseHandler.success(req, res, { ok: r.ok, message: r.message, state });
    } catch (error: any) {
      await writeAudit(req, {
        action: 'demo.reset',
        targetType: 'demoTenant',
        statusCode: error?.code || 500,
        details: { error: error?.message || String(error) },
      });
      await ApiResponseHandler.error(req, res, error);
    }
  });
};
