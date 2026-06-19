import { databaseInit } from '../database/databaseConnection';

export async function databaseMiddleware(req, res, next) {
  try {
    const database = await databaseInit();
    req.database = database;
    next();
  } catch (error) {
    // Fail fast with 503 instead of proceeding with req.database undefined
    // (which produced opaque 500s / null-derefs and hid DB outages from the LB
    // health check). A clean 503 lets a load balancer route away.
    console.error('[databaseMiddleware] DB init failed:', (error as any)?.message || error);
    res.status(503).json({ message: 'Service temporarily unavailable (database).' });
  }
}
