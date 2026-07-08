/**
 * Radio "Canal abierto" — MIGRATED to LiveKit (WebRTC). The old socket.io +
 * µ-law voice relay is gone; this is now a thin shim that keeps the SAME public
 * API its callers use, delegating audio to the server-side LiveKit publisher
 * (lib/livekitBroadcast). Consumers unchanged:
 *   - radioCheck{Ai,}Service → broadcastPcm  (AI "pase de novedades" TTS)
 *   - supervisor/radioChannels → voiceOnlineCount (live presence)
 *   - services/radio/sipBridgeService → bridge{Begin,SendPcm,End} + RELAY_CHANNEL
 *
 * The socket-relay entry points (initRelay / registerRadioVoice) are retired
 * no-ops — realtime.ts no longer wires the radio into socket.io.
 */
import {
  broadcastPcmToLiveKit,
  roomParticipantCount,
  bridgeBeginLiveKit,
  bridgeSendPcmLiveKit,
  bridgeEndLiveKit,
} from './livekitBroadcast';

/** Retired: the socket.io voice relay was replaced by LiveKit. No-op. */
export async function initRelay(_io?: any): Promise<void> { /* retired */ }
/** Retired: per-socket PTT handlers replaced by the LiveKit client. No-op. */
export function registerRadioVoice(_io?: any, _socket?: any): void { /* retired */ }
/** Kept only for import compatibility with the dormant SIP bridge. */
export const RELAY_CHANNEL = 'rcv:event';

/** Speak a PCM clip into the tenant's live channel (radio-check TTS). */
export async function broadcastPcm(
  tenantId: string,
  pcm: Int16Array,
  inRate: number,
  speakerName = 'Central de monitoreo',
): Promise<void> {
  return broadcastPcmToLiveKit(tenantId, pcm, inRate, speakerName);
}

/** Live count of people on the channel (LiveKit room participants). */
export async function voiceOnlineCount(tenantId: string): Promise<number> {
  return roomParticipantCount(tenantId);
}

// SIP bridge hooks (dormant) — now publish into LiveKit.
export async function bridgeBegin(tenantId: string, speakerName = 'Radio'): Promise<boolean> {
  return bridgeBeginLiveKit(tenantId, speakerName);
}
export function bridgeSendPcm(tenantId: string, pcm: Int16Array, inRate: number): void {
  bridgeSendPcmLiveKit(tenantId, pcm, inRate);
}
export async function bridgeEnd(tenantId: string): Promise<void> {
  return bridgeEndLiveKit(tenantId);
}
