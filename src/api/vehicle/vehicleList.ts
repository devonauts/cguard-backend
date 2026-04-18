import { Request, Response } from 'express';

const handler = async (req: Request, res: Response) => {
  try {
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
    return res.status(500).json({ message: (err as any)?.message || String(err) });
  }
};

export default handler;
