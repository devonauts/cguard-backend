import { Router, Request, Response } from 'express';

export default function geocodeRoutes(routes: Router) {
  const CACHE_TTL = Number(process.env.GEOCODE_CACHE_TTL_MS) || 24 * 60 * 60 * 1000; // 24h default
  const cache = new Map<string, { ts: number; data: any }>();

  function getCached(key: string) {
    const entry = cache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.ts > CACHE_TTL) {
      cache.delete(key);
      return null;
    }
    return entry.data;
  }

  function setCached(key: string, data: any) {
    try {
      cache.set(key, { ts: Date.now(), data });
    } catch {}
  }

  async function proxyFetch(url: string, init: any = {}) {
    const headers: any = init.headers || {};
    // Respect Nominatim usage policy: include a sensible User-Agent and contact if available
    headers['User-Agent'] = headers['User-Agent'] || (process.env.NOMINATIM_USER_AGENT || 'cguard-backend/1.0 (contact@cguard.app)');
    if (process.env.NOMINATIM_EMAIL) headers['From'] = process.env.NOMINATIM_EMAIL;
    return fetch(url, { ...init, headers });
  }

  routes.get('/geocode/reverse', async (req: Request, res: Response) => {
    try {
      const lat = String(req.query.lat || req.query.latitude || '');
      const lon = String(req.query.lon || req.query.longitude || req.query.lng || '');
      if (!lat || !lon) return res.status(400).json({ message: 'lat and lon are required' });

      const key = `reverse:${lat},${lon}:${JSON.stringify(req.query)}`;
      const cached = getCached(key);
      if (cached) return res.json(cached);

      const base = 'https://nominatim.openstreetmap.org/reverse';
      const params = new URLSearchParams();
      // forward query params but ensure format
      Object.keys(req.query).forEach((k) => params.set(k, String((req.query as any)[k] as string)));
      if (!params.get('format')) params.set('format', 'jsonv2');
      const url = `${base}?${params.toString()}`;

      const upstream = await proxyFetch(url);
      if (upstream.status === 429) {
        const ra = upstream.headers.get('retry-after');
        if (ra) res.setHeader('Retry-After', ra);
      }
      const data = await upstream.json().catch(() => null);
      if (!upstream.ok) return res.status(upstream.status).json(data || { message: 'Upstream error' });
      setCached(key, data);
      return res.json(data);
    } catch (err) {
      console.error('geocode/reverse error', err);
      return res.status(500).json({ message: 'Internal error' });
    }
  });

  routes.get('/geocode/search', async (req: Request, res: Response) => {
    try {
      const q = String(req.query.q || req.query.query || '');
      if (!q) return res.status(400).json({ message: 'q is required' });

      const key = `search:${q}:${JSON.stringify(req.query)}`;
      const cached = getCached(key);
      if (cached) return res.json(cached);

      const base = 'https://nominatim.openstreetmap.org/search';
      const params = new URLSearchParams();
      Object.keys(req.query).forEach((k) => params.set(k, String((req.query as any)[k] as string)));
      if (!params.get('format')) params.set('format', 'jsonv2');
      const url = `${base}?${params.toString()}`;

      const upstream = await proxyFetch(url);
      if (upstream.status === 429) {
        const ra = upstream.headers.get('retry-after');
        if (ra) res.setHeader('Retry-After', ra);
      }
      const data = await upstream.json().catch(() => null);
      if (!upstream.ok) return res.status(upstream.status).json(data || { message: 'Upstream error' });
      setCached(key, data);
      return res.json(data);
    } catch (err) {
      console.error('geocode/search error', err);
      return res.status(500).json({ message: 'Internal error' });
    }
  });
}
