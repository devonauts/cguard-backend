import { Request, Response } from 'express';
import crypto from 'crypto';
import RequestShareRepository from '../../database/repositories/requestShareRepository';

export default async function requestShare(req: Request, res: Response) {
  try {
    const tenantId = req.params.tenantId;
    const id = req.params.id;
    if (!tenantId || !id) return res.status(400).json({ message: 'Missing params' });

    // generate token
    const token = crypto.randomBytes(16).toString('hex');

    const options: any = { database: (req as any).database };
    // accept optional expiresAt from request body (ISO string or timestamp)
    let expiresAt: string | null = null;
    if (req.body && req.body.expiresAt) {
      const parsed = new Date(req.body.expiresAt);
      if (!isNaN(parsed.getTime())) {
        // store as ISO string to avoid TS type mismatches with Date
        expiresAt = parsed.toISOString();
      }
    }

    const record = await RequestShareRepository.create({
      tenantId,
      requestId: id,
      token,
      expiresAt,
    }, options);

    const host = req.get('host');
    const protocol = req.protocol;
    const publicUrl = `${protocol}://${host}/public/dispatch/${token}`;

    return res.json({ token, url: publicUrl });
  } catch (err: any) {
    console.error('requestShare error', err);
    // In development, return error details to help debugging
    if (process.env.NODE_ENV !== 'production') {
      return res.status(500).json({ message: 'Internal error', error: err && err.message, stack: err && err.stack });
    }
    return res.status(500).json({ message: 'Internal error' });
  }
}
