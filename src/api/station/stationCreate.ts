import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import StationService from '../../services/stationService';

export default async (req, res, next) => {
  try {
    new PermissionChecker(req).validateHas(
      Permissions.values.stationCreate,
    );

    // Accept both {data:{...}} (what the CRM sends) and a bare body. Reading
    // req.body.data blindly made a body without the wrapper throw
    // "Cannot read properties of undefined (reading 'stationOrigin')" deep in
    // the service — a 500 for what is really a malformed request.
    const data = req.body?.data ?? req.body;
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      res.status(400).send({ message: 'Cuerpo de la petición inválido: falta el objeto del puesto.' });
      return;
    }

    const payload = await new StationService(req).create(data);

    await ApiResponseHandler.success(req, res, payload);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
