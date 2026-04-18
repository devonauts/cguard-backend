import { Request, Response } from 'express';

const handler = async (req: Request, res: Response) => {
  try {
    const { query = '' } = req.query as any;
    const tenant = (req as any).tenant;
    // Use req so the service has access to req.database and req.currentUser
    const service = new (require('../../services/vehicleService').default)(req as any);
    const result = await service.findAllAutocomplete(query, 20);
    return res.json(result);
  } catch (err: any) {
    console.error('[vehicle.autocomplete] error', err);
    return res.status(500).json({ message: err?.message || String(err) });
  }
};

export default handler;
