import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import { voiceOnlineCount } from '../../lib/radioVoice';

/**
 * Radio channels for the supervisor "Radio" screen. The live PTT backend
 * (radioVoice.ts) is a single tenant-wide voice room shared by supervisors,
 * guards and the CRM RadioDispatch, so today there is exactly ONE real channel
 * ("Operaciones") and its online count is the live socket presence. This
 * endpoint exists so the app renders channels from the backend (not a
 * hardcoded list); adding true per-channel isolation is a backend follow-up
 * (parameterize the room/floor/relay by channel key).
 *
 * GET /tenant/:tenantId/supervisor/me/radio/channels
 */
export const getRadioChannels = async (req: any, res: any) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.supervisorMe);
    const tenantId = req.currentTenant.id;

    let online = 0;
    try { online = await voiceOnlineCount(tenantId); } catch { /* best-effort */ }

    const channels = [
      {
        id: 'general',
        key: 'general',
        name: 'Operaciones',
        description: 'Comunicaciones de operaciones y avisos críticos de toda la empresa.',
        type: 'operations',
        live: true,
        online,
      },
    ];

    await ApiResponseHandler.success(req, res, { channels });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};

export default getRadioChannels;
