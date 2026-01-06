export function languageMiddleware(req, res, next) {
  // Allow explicit override via query `?lang=es` or header `x-language: es`
  const overrideLang = (req.query && req.query.lang) || req.headers['x-language'] || req.headers['x-lang'];
  if (overrideLang) {
    const ol = String(overrideLang).toLowerCase();
    if (ol.startsWith('es')) {
      req.language = 'es';
      return next();
    }
    if (ol.startsWith('pt')) {
      req.language = 'pt-BR';
      return next();
    }
    req.language = 'en';
    return next();
  }

  const header = req.headers['accept-language'] || '';
  const supported = ['en', 'es', 'pt-BR'];

  // Parse Accept-Language properly and choose the supported language with highest q
  try {
    const parts = String(header).split(',').map((p) => p.trim()).filter(Boolean);
    const scores: Array<{ code: string; q: number; raw: string }> = [];
    for (const part of parts) {
      const [localePart, qPart] = part.split(';').map((s) => s.trim());
      let q = 1;
      if (qPart && qPart.startsWith('q=')) {
        const v = parseFloat(qPart.slice(2));
        if (!Number.isNaN(v)) q = v;
      }
      scores.push({ code: localePart.toLowerCase(), q, raw: part });
    }

    // Find supported language with highest q
    let best = null as null | { lang: string; q: number };
    for (const s of scores) {
      if (s.code.startsWith('es')) {
        if (!best || s.q > best.q) best = { lang: 'es', q: s.q };
      } else if (s.code.startsWith('pt')) {
        if (!best || s.q > best.q) best = { lang: 'pt-BR', q: s.q };
      } else if (s.code.startsWith('en')) {
        if (!best || s.q > best.q) best = { lang: 'en', q: s.q };
      }
    }

    if (best) {
      req.language = best.lang;
      return next();
    }
  } catch (e) {
    // ignore and fallback
  }

  // Default to Spanish (app default) if nothing matches
  req.language = 'es';
  return next();
}
