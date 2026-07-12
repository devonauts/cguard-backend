/**
 * metaWhatsAppProvider — Meta WhatsApp Cloud API (Graph API).
 *
 *   POST https://graph.facebook.com/{apiVersion}/{phoneNumberId}/messages
 *
 * Two message shapes:
 *   (a) template  — {type:'template', template:{name, language:{code}, components:[
 *                     {type:'body', parameters:[{type:'text', text}]}]}}
 *   (b) text      — {type:'text', text:{body}}  ← ONLY inside Meta's 24h
 *                    customer-service window (a recent inbound from the recipient).
 *
 * Outside the 24h window, free-form text is NOT delivered by Meta, so we require
 * a template. OTP is AUTHENTICATION-template-only and never free-form text.
 *
 * NON-BREAKING / isolation: all Graph-API specifics live here. Credentials are
 * resolved PER TENANT first (the tenant's own WhatsApp Business account from
 * tenantWhatsappAccounts, connected via Meta Embedded Signup), falling back to
 * the legacy global config from communicationSettingsService.getMetaConfig
 * (encrypted db → env) during rollout. NEVER from the frontend. The router owns
 * wallet debits + logging; this provider only sends and returns a SendResult
 * (with a cost ESTIMATE for the router).
 */
import { CommunicationProvider, OutboundMessage, SendResult } from '../types';
import {
  getMetaConfig,
  isMetaConfigured,
  estimateCost,
  getSettings,
} from '../communicationSettingsService';
import { resolveTenantWhatsappConfig } from '../whatsapp/tenantWhatsappService';
import { isWithinWindow } from '../whatsappSessionService';
import { toWhatsAppRecipient } from '../phone';

const GRAPH_BASE = 'https://graph.facebook.com';

/** Order template body params: prefer numeric keys ('1','2',...), else insertion order. */
function orderedParams(vars?: Record<string, string>): string[] {
  if (!vars) return [];
  const keys = Object.keys(vars);
  const allNumeric = keys.length > 0 && keys.every((k) => /^\d+$/.test(k));
  const sorted = allNumeric ? keys.sort((a, b) => Number(a) - Number(b)) : keys;
  return sorted.map((k) => String(vars[k] ?? ''));
}

function buildTemplatePayload(
  to: string,
  templateName: string,
  languageCode: string,
  vars?: Record<string, string>,
) {
  const params = orderedParams(vars);
  const components = params.length
    ? [
        {
          type: 'body',
          parameters: params.map((text) => ({ type: 'text', text })),
        },
      ]
    : [];
  return {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'template',
    template: {
      name: templateName,
      language: { code: languageCode },
      ...(components.length ? { components } : {}),
    },
  };
}

function buildTextPayload(to: string, body: string) {
  return {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'text',
    text: { preview_url: false, body },
  };
}

export class MetaWhatsAppProvider implements CommunicationProvider {
  channel = 'whatsapp' as const;

  async isConfigured(db: any, tenantId: string): Promise<boolean> {
    // Per-tenant account first (Embedded Signup) …
    const tenantCfg = await resolveTenantWhatsappConfig(db, tenantId).catch(() => null);
    if (tenantCfg) return true;
    // … falling back to the legacy global config during rollout.
    return isMetaConfigured(db);
  }

  async send(db: any, msg: OutboundMessage): Promise<SendResult> {
    // Per-tenant account first (Embedded Signup); legacy global config fallback.
    const cfg =
      (await resolveTenantWhatsappConfig(db, msg.tenantId).catch(() => null)) ||
      (await getMetaConfig(db).catch(() => null));
    if (!cfg || !cfg.accessToken || !cfg.phoneNumberId) {
      return { status: 'skipped', channel: 'whatsapp', provider: 'meta', skipReason: 'not_configured' };
    }

    // Resolve a country default for normalization + cost estimation.
    const settings = await getSettings(db, msg.tenantId).catch(() => null);
    const defaultCc = settings?.default_country_code || '+593';

    const to = toWhatsAppRecipient(msg.recipient, defaultCc);
    if (!to) {
      return {
        status: 'failed',
        channel: 'whatsapp',
        provider: 'meta',
        error: 'invalid_recipient',
      };
    }

    // Decide template vs free-form text.
    const isOtp = msg.messageType === 'otp';
    let payload: any;

    if (msg.templateName) {
      // Explicit template requested — always allowed (business-initiated).
      payload = buildTemplatePayload(
        to,
        msg.templateName,
        msg.languageCode || 'es',
        msg.templateVars,
      );
    } else if (isOtp) {
      // OTP MUST use an AUTHENTICATION template, never free-form text.
      return {
        status: 'skipped',
        channel: 'whatsapp',
        provider: 'meta',
        skipReason: 'otp_requires_template',
      };
    } else {
      // No template name: free-form text is only deliverable inside the 24h
      // customer-service window. Outside it, Meta rejects/charges nothing useful,
      // so we skip and let the router fall through (e.g. to SMS).
      const withinWindow = await isWithinWindow(db, msg.tenantId, '+' + to).catch(() => false);
      if (!withinWindow) {
        return {
          status: 'skipped',
          channel: 'whatsapp',
          provider: 'meta',
          skipReason: 'outside_24h_window_no_template',
        };
      }
      const body = [msg.title, msg.body].filter(Boolean).join('\n\n').trim();
      if (!body) {
        return {
          status: 'skipped',
          channel: 'whatsapp',
          provider: 'meta',
          skipReason: 'empty_body',
        };
      }
      payload = buildTextPayload(to, body);
    }

    // Cost estimate for the router (it owns the wallet debit).
    const est = await estimateCost(db, 'meta', 'whatsapp', defaultCc, msg.messageType).catch(
      () => null,
    );
    const costEstimateCents = est?.costCents ?? undefined;

    const url = `${GRAPH_BASE}/${cfg.apiVersion}/${cfg.phoneNumberId}/messages`;

    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${cfg.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      const json: any = await resp.json().catch(() => ({}));

      if (!resp.ok) {
        // Meta error envelope: { error: { message, code, error_subcode, ... } }
        const err = json?.error || {};
        return {
          status: 'failed',
          channel: 'whatsapp',
          provider: 'meta',
          error: err.message || `meta_http_${resp.status}`,
          providerResponse: json,
          costEstimateCents,
        };
      }

      const providerMessageId =
        json?.messages && json.messages[0] && json.messages[0].id
          ? String(json.messages[0].id)
          : undefined;

      return {
        status: 'sent',
        channel: 'whatsapp',
        provider: 'meta',
        providerMessageId,
        providerResponse: json,
        costEstimateCents,
      };
    } catch (e: any) {
      return {
        status: 'failed',
        channel: 'whatsapp',
        provider: 'meta',
        error: e?.message || String(e),
        costEstimateCents,
      };
    }
  }
}

export const metaWhatsAppProvider = new MetaWhatsAppProvider();
export default metaWhatsAppProvider;
