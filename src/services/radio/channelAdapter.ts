/**
 * Radio channel adapter — the seam between the radio-check engine and however a
 * guard is actually reached. Phase 1 ships the AppChannelAdapter (FCM push to the
 * worker app, record-and-forward replies). Phase 2 adds a WavePtxChannelAdapter
 * (Motorola WAVE PTX broadband PTT: live voice + server-initiated audio announce)
 * implementing the SAME interface, selected per tenant via getChannelAdapter().
 * The engine depends only on this interface, never on a concrete adapter.
 */
export interface RadioChannelContext {
  db: any;
  tenantId: string;
}

export interface RadioNotifyPayload {
  sessionId: string;
  entryId: string;
  stationId: string;
  stationName: string;
  promptText: string;
}

export interface RadioChannelAdapter {
  /** What this channel can do, so callers branch without type-checking concretes. */
  capabilities: { liveVoice: boolean; serverInitiatedAudio: boolean };
  /** Notify the on-duty guard(s) that a radio check is requested for an entry. */
  notifyGuards(ctx: RadioChannelContext, userIds: string[], payload: RadioNotifyPayload): Promise<void>;
  /** (Phase 2) Announce/broadcast over the channel. No-op for the app channel. */
  announce?(ctx: RadioChannelContext, sessionId: string, text: string): Promise<void>;
}

import { AppChannelAdapter } from './appChannelAdapter';

const appAdapter = new AppChannelAdapter();

/**
 * Resolve the adapter for a tenant. Phase 1 always returns the app adapter; the
 * `channel` setting ('wave_ptx') will select a WAVE PTX adapter in Phase 2.
 */
export function getChannelAdapter(_channel?: string): RadioChannelAdapter {
  // if (_channel === 'wave_ptx') return wavePtxAdapter; // Phase 2
  return appAdapter;
}
