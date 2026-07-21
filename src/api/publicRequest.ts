import { Request, Response } from 'express';
import RequestShareRepository from '../database/repositories/requestShareRepository';
import RequestRepository from '../database/repositories/requestRepository';

export default async function publicRequest(req: Request, res: Response) {
  try {
    const token = req.params.token;
    if (!token) return res.status(400).json({ message: 'Missing token' });

    const options: any = { database: (req as any).database };
    const share = await RequestShareRepository.findByToken(token, options);
    if (!share) return res.status(404).json({ message: 'Not found or expired' });

    // Use RequestRepository to fetch the request within the tenant scope
    const requestId = share.requestId || (share.request && share.request.id);
    const tenantId = share.tenantId || (share.tenant && share.tenant.id);
    if (!requestId || !tenantId) return res.status(404).json({ message: 'Invalid share' });

    // reuse options and add currentTenant to satisfy repository call
    options.currentTenant = { id: tenantId };
    let result;
    try {
      result = await RequestRepository.findById(requestId, options);
    } catch (notFound) {
      // A valid share token whose request no longer exists (or is another
      // tenant's) is a 404, not a server error. Swallowing it as 500 told the
      // public caller "our fault" for a plain not-found.
      return res.status(404).json({ message: 'Request not found' });
    }

    // Return the request payload
    return res.json(result);
  } catch (err) {
    console.error('publicRequest error', err);
    return res.status(500).json({ message: 'Internal error' });
  }
}
