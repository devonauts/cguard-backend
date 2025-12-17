import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import BusinessInfoService from '../../services/businessInfoService';
import ClientAccountService from '../../services/clientAccountService';

export default async (req, res, next) => {
  try {
    new PermissionChecker(req).validateHas(
      Permissions.values.businessInfoRead,
    );

    const payload = await new BusinessInfoService(
      req,
    ).findAndCountAll(req.query);

    // Attach client account name (name + lastName) when clientAccountId present
    try {
      if (payload && Array.isArray(payload.rows) && payload.rows.length) {
        const clientService = new ClientAccountService(req);
        const ids = Array.from(new Set(payload.rows
          .filter((r) => r.clientAccountId)
          .map((r) => r.clientAccountId),
        ));

        const clientsById = {};
        await Promise.all(ids.map(async (id) => {
          try {
            const c = await clientService.findById(id);
            clientsById[id] = c;
          } catch (e) {
            clientsById[id] = null;
          }
        }));

        payload.rows = payload.rows.map((r) => {
          const client = r.clientAccountId ? clientsById[r.clientAccountId] : null;
          const clientName = client ? `${client.name || ''} ${client.lastName || ''}`.trim() : null;

          // legacy compatibility: frontend originally expects `name`, `clientId`, and `client` object
          const legacyClient = client
            ? {
                id: client.id,
                name: client.name || null,
                lastName: client.lastName || null,
                email: client.email || null,
              }
            : null;

          return {
            ...r,
            clientAccountName: clientName,
            // legacy keys
            name: r.companyName,
            clientId: r.clientAccountId,
            client: legacyClient,
            // common aliases expected by older frontend
            latitude: r.latitud || r.latitude || null,
            longitude: r.longitud || r.longitude || null,
            phone: r.contactPhone || r.phone || null,
            email: r.contactEmail || r.email || null,
          };
        });
      }

      // Debug: log payload that will be sent to frontend
      console.log('businessInfoList payload sample:',
        Array.isArray(payload.rows) ? payload.rows.slice(0,3) : payload.rows,
      );
    } catch (e) {
      console.error('Error logging businessInfoList payload:', e);
    }

    await ApiResponseHandler.success(req, res, payload);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
