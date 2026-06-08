/**
 * Police dispatch connector. When an ASAP gateway is configured (env
 * ASAP_GATEWAY_URL) and the panel carries an ORI, sends a structured
 * ASAP-to-PSAP dispatch request to the gateway and returns its reference;
 * otherwise returns the manual PSAP contact for the operator to call.
 *
 * Real ASAP activation requires the tenant's ASAP/Nlets participation + gateway
 * credentials — this is the integration point, with a safe manual fallback.
 */
const ASAP_GATEWAY_URL = process.env.ASAP_GATEWAY_URL || '';
const ASAP_GATEWAY_KEY = process.env.ASAP_GATEWAY_KEY || '';

export interface PoliceDispatchResult {
  mode: 'asap' | 'manual';
  ref: string | null;
  agency: string | null;
  phone: string | null;
  message: string;
}

export async function dispatchPolice(
  panel: any,
  alarmCase: any,
  opts: { note?: string } = {},
): Promise<PoliceDispatchResult> {
  const agency = (panel && panel.psapAgency) || null;
  const phone = (panel && panel.psapPhone) || null;
  const ori = (panel && panel.asapOri) || null;

  if (ASAP_GATEWAY_URL && ori) {
    const payload = {
      ori,
      account: panel.accountNumber,
      agency,
      alarm: {
        caseId: alarmCase.id,
        category: alarmCase.category,
        priority: alarmCase.priority,
        title: alarmCase.title,
      },
      site: { stationId: panel.stationId, postSiteId: panel.postSiteId },
      note: opts.note || null,
      ts: new Date().toISOString(),
    };
    try {
      const r = await (fetch as any)(`${ASAP_GATEWAY_URL.replace(/\/+$/, '')}/dispatch`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(ASAP_GATEWAY_KEY ? { authorization: `Bearer ${ASAP_GATEWAY_KEY}` } : {}),
        },
        body: JSON.stringify(payload),
      });
      if (r && r.ok) {
        const data = await r.json().catch(() => ({}));
        const ref = String(data.ref || data.id || data.reference || `ASAP-${Date.now()}`);
        return { mode: 'asap', ref, agency, phone, message: `Despacho ASAP enviado a ${agency || 'PSAP'} (ref ${ref})` };
      }
      return { mode: 'manual', ref: null, agency, phone, message: `Gateway ASAP no respondió — despacho manual: llame a ${agency || 'PSAP'}${phone ? ` (${phone})` : ''}` };
    } catch (e: any) {
      return { mode: 'manual', ref: null, agency, phone, message: `Error ASAP (${e?.message || e}) — despacho manual: llame a ${agency || 'PSAP'}${phone ? ` (${phone})` : ''}` };
    }
  }

  return {
    mode: 'manual',
    ref: null,
    agency,
    phone,
    message: phone
      ? `Despacho manual: llame a ${agency || 'PSAP'} ${phone}`
      : 'Despacho manual: configure el PSAP del panel (agencia/teléfono)',
  };
}
