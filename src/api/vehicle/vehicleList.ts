import { Request, Response } from 'express';
import PermissionChecker from '../../services/user/permissionChecker';
import Permissions from '../../security/permissions';
import ApiResponseHandler from '../apiResponseHandler';

const handler = async (req: Request, res: Response) => {
  try {
    new PermissionChecker(req as any).validateHas(
      Permissions.values.vehicleRead,
    );
    const { limit = 50, offset = 0 } = req.query as any;
    const tenant = (req as any).tenant;
    // Construct service with the request so it has access to req.database
    const service = new (require('../../services/vehicleService').default)(req as any);
    const params = { filter: {}, limit: Number(limit), offset: Number(offset) } as any;
    if (req.query.active !== undefined) {
      params.filter.active = String(req.query.active) === 'true' || String(req.query.active) === '1';
    }

    const { rows, count } = await service.findAndCountAll(params);
    return res.json({ rows, count });
  } catch (err) {
    console.error('[vehicle.list] error', err);
    return ApiResponseHandler.error(req, res, err);
  }
};

export default handler;
