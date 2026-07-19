import { Request, Response } from 'express';
import PermissionChecker from '../../services/user/permissionChecker';
import Permissions from '../../security/permissions';
import ApiResponseHandler from '../apiResponseHandler';

const handler = async (req: Request, res: Response) => {
  try {
    new PermissionChecker(req as any).validateHas(
      Permissions.values.vehicleAutocomplete,
    );
    const { query = '' } = req.query as any;
    const tenant = (req as any).tenant;
    // Use req so the service has access to req.database and req.currentUser
    const service = new (require('../../services/vehicleService').default)(req as any);
    const result = await service.findAllAutocomplete(query, 20);
    return res.json(result);
  } catch (err: any) {
    console.error('[vehicle.autocomplete] error', err);
    return ApiResponseHandler.error(req, res, err);
  }
};

export default handler;
