import { Request, Response } from 'express';

/**
 * Public (unauthenticated) certificate view: GET /public/training/cert/:downloadToken
 *
 * Validates the opaque downloadToken against the stored certificate. Returns
 * the rendered HTML + identifying fields for a shareable, printable view. No
 * tenant scoping needed — the token IS the capability.
 */
export default async function publicTrainingCertificate(req: Request, res: Response) {
  try {
    const token = (req.params as any).downloadToken;
    if (!token) return res.status(400).json({ message: 'Missing token' });

    const db = (req as any).database;
    const cert = await db.trainingCertificate.findOne({
      where: { downloadToken: token, deletedAt: null },
    });
    if (!cert) return res.status(404).json({ message: 'Not found or expired' });

    return res.json({
      htmlContent: cert.htmlContent,
      guardName: cert.guardName,
      courseTitle: cert.courseTitle,
      serialNumber: cert.serialNumber,
      score: cert.score,
      issuedAt: cert.issuedAt,
    });
  } catch (err) {
    console.error('publicTrainingCertificate error', err);
    return res.status(500).json({ message: 'Internal error' });
  }
}
