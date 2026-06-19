import { pushToUser } from '../pushService';
import type { RadioChannelAdapter, RadioChannelContext, RadioNotifyPayload } from './channelAdapter';

/**
 * Phase-1 channel: reach the guard through the worker app. A radio-check request
 * is delivered as an FCM push (data.type='radio.check_request'); the worker also
 * polls GET /guard/me/radio-check/pending, so delivery never depends on push. The
 * guard answers record-and-forward (no live voice / no server-initiated audio).
 */
export class AppChannelAdapter implements RadioChannelAdapter {
  capabilities = { liveVoice: false, serverInitiatedAudio: false };

  async notifyGuards(ctx: RadioChannelContext, userIds: string[], payload: RadioNotifyPayload): Promise<void> {
    const targets = (userIds || []).filter(Boolean);
    await Promise.all(
      targets.map((uid) =>
        pushToUser(ctx.db, ctx.tenantId, uid, {
          title: 'Radio check',
          body: payload.promptText || 'Reporte de novedades del puesto',
          data: {
            type: 'radio.check_request',
            sessionId: payload.sessionId,
            entryId: payload.entryId,
            stationId: payload.stationId,
            promptAudioUrl: payload.promptAudioUrl || '',
          },
        }).catch(() => undefined),
      ),
    );
  }
}
