import express from 'express';
import https from 'https';
import cors from 'cors';
import { authMiddleware } from '../middlewares/authMiddleware';
import ApiResponseHandler from './apiResponseHandler';
import { tenantMiddleware } from '../middlewares/tenantMiddleware';
import { databaseMiddleware } from '../middlewares/databaseMiddleware';
import bodyParser from 'body-parser';
import multer from 'multer';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { createRateLimiter } from './apiRateLimiter';
import Error401 from '../errors/Error401';
import { languageMiddleware } from '../middlewares/languageMiddleware';
import authSocial from './auth/authSocial';
import setupSwaggerUI from './apiDocumentation';
import * as tenantUserClientAccounts from './tenantUserClientAccounts';

const app = express();

app.set('trust proxy', 1);

// API responses are per-user, authenticated JSON — never cacheable. Without
// this, express's default ETag plus the browser's heuristic caching produce
// 304 Not Modified revalidations whose EMPTY body the frontend silently maps
// to an empty list ("the page shows nothing but the data exists" — the same
// bug businessInfoList once patched ad-hoc with a per-route no-store header).
// Disabling ETags and sending no-store globally closes the entire class.
app.disable('etag');
app.use((_req: any, res: any, next: any) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});
// CORS — explicit allowlist instead of reflecting ANY origin with credentials.
// Allowed: configured web origins (CORS_ORIGINS env, comma-separated) + any
// *.cguardpro.com host; plus the mobile app (Capacitor/Ionic webview origins:
// capacitor://, ionic://, http(s)://localhost) and no-origin requests (native
// HTTP clients / server-to-server). Everything else is rejected.
const corsAllowlist = (process.env.CORS_ORIGINS || 'https://app.cguardpro.com,https://api.cguardpro.com')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);
function isAllowedOrigin(origin?: string): boolean {
  if (!origin) return true; // mobile native / curl / same-origin server calls
  if (corsAllowlist.includes(origin)) return true;
  try {
    const u = new URL(origin);
    if (u.protocol === 'capacitor:' || u.protocol === 'ionic:') return true; // mobile webview
    if (u.hostname === 'localhost' || u.hostname === '127.0.0.1') return true; // dev + Android webview
    if (u.hostname === 'cguardpro.com' || u.hostname.endsWith('.cguardpro.com')) return true;
  } catch {
    /* malformed origin → reject */
  }
  return false;
}
app.use(
  cors({
    origin: (origin: any, cb: any) =>
      isAllowedOrigin(origin) ? cb(null, true) : cb(new Error('Not allowed by CORS')),
    credentials: true,
  }),
);

// Seed the per-request context (AsyncLocalStorage) as early as possible so slow
// queries, errors, and N+1 detection can attribute themselves to this request
// without threading req everywhere. tenantId is parsed from the /tenant/:id path;
// userId is enriched after authMiddleware.
app.use((req: any, res: any, next: any) => {
  try {
    const { runWithContext, newRequestId } = require('../lib/requestContext');
    const rawPath = String(req.originalUrl || req.url || '').split('?')[0];
    const requestId = String(req.headers['x-request-id'] || newRequestId()).slice(0, 32);
    res.setHeader('X-Request-Id', requestId);
    const tenantMatch = rawPath.match(/\/tenant\/([0-9a-fA-F-]{36})/);
    const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    runWithContext(
      {
        requestId,
        method: req.method,
        path: rawPath.slice(0, 255),
        tenantId: tenantMatch ? tenantMatch[1] : null,
        ip: fwd || req.ip || null,
        userAgent: String(req.headers['user-agent'] || '').slice(0, 255) || null,
      },
      () => next(),
    );
  } catch {
    next();
  }
});

// Initializes and adds the database middleware.
app.use(databaseMiddleware);

// Sets the current language of the request
app.use(languageMiddleware);

// Public shared request route (no auth)
app.get('/public/dispatch/:token', require('./publicRequest').default);

// Public training certificate view/share (no auth; token validates)
app.get('/public/training/cert/:downloadToken', require('./publicTrainingCertificate').default);

// Public Meta WhatsApp webhook (no auth; verify_token / HMAC signature validate).
// Mounted before authMiddleware. GET = verification handshake, POST = callbacks.
app.get(
  '/communications/webhooks/meta/whatsapp',
  require('./communication/metaWebhook').metaWebhookVerify,
);
app.post(
  '/communications/webhooks/meta/whatsapp',
  require('./communication/metaWebhook').metaWebhookReceive,
);

// Meta app compliance callbacks (no auth; signed_request HMAC validates).
// Meta POSTs application/x-www-form-urlencoded — attach a urlencoded parser
// per-route (the global body parser below is JSON-only).
const metaUrlencoded = express.urlencoded({ extended: false });
app.post(
  '/communications/webhooks/meta/deauthorize',
  metaUrlencoded,
  require('./communication/metaCompliance').metaDeauthorize,
);
app.post(
  '/communications/webhooks/meta/data-deletion',
  metaUrlencoded,
  require('./communication/metaCompliance').metaDataDeletion,
);

// Platform Twilio phone center webhooks (no auth; X-Twilio-Signature validates).
// Mounted before authMiddleware. Twilio POSTs application/x-www-form-urlencoded,
// and the global body parser below is JSON-only, so attach a urlencoded parser
// per-route. Voice routes return TwiML (XML).
const twilioUrlencoded = express.urlencoded({ extended: false });
app.post(
  '/communications/webhooks/twilio/sms',
  twilioUrlencoded,
  require('./twilio/webhooks').twilioSmsInbound,
);
app.post(
  '/communications/webhooks/twilio/sms-status',
  twilioUrlencoded,
  require('./twilio/webhooks').twilioSmsStatus,
);
app.post(
  '/communications/webhooks/twilio/voice',
  twilioUrlencoded,
  require('./twilio/webhooks').twilioVoiceInbound,
);
app.post(
  '/communications/webhooks/twilio/voice-status',
  twilioUrlencoded,
  require('./twilio/webhooks').twilioVoiceStatus,
);
app.post(
  '/communications/webhooks/twilio/voice-outbound',
  twilioUrlencoded,
  require('./twilio/webhooks').twilioVoiceOutbound,
);

// SendGrid Event Webhook (no auth; optional ?key=SENDGRID_WEBHOOK_SECRET guard).
// Posts a JSON array of delivery events → recorded as email.* in the audit log.
app.post(
  '/email/webhooks/sendgrid',
  express.json({ limit: '2mb' }),
  require('./email/sendgridWebhook').sendgridEventWebhook,
);

// Proxy endpoints for Google Places (server-side) to avoid CORS issues.
// Mounted before authMiddleware (mobile clients call it without a session), so
// without its own limiter every anonymous hit spends paid Google API quota —
// give it a tight per-IP budget.
const placesRateLimiter = createRateLimiter({
  name: 'places',
  max: Number(process.env.RATE_LIMIT_PLACES_MAX) || 30,
  windowMs: 60 * 1000,
  message: 'errors.429',
});
app.get('/api/places/autocomplete', placesRateLimiter, (req, res) => {
  const input = String(req.query.input || '');
  const lang = String(req.query.language || 'es');
  const key = process.env.GOOGLE_MAPS_API_KEY || process.env.FLUTTER_GOOGLE_MAPS_API_KEY || process.env.GOOGLE_API_KEY;
  if (!key) return res.status(500).json({ message: 'maps_key_missing' });
  const uri = `https://maps.googleapis.com/maps/api/place/autocomplete/json?input=${encodeURIComponent(input)}&key=${key}&types=address&language=${encodeURIComponent(lang)}`;
  return https.get(uri, (r) => {
    let data = '';
    r.on('data', (chunk) => (data += chunk));
    r.on('end', () => {
      res.set('Content-Type', 'application/json');
      res.send(data);
    });
  }).on('error', (err) => {
    console.error('Places autocomplete proxy error:', err);
    res.status(502).json({ message: 'places_proxy_error' });
  });
});

app.get('/api/places/details', placesRateLimiter, (req, res) => {
  const placeId = String(req.query.place_id || '');
  const key = process.env.GOOGLE_MAPS_API_KEY || process.env.FLUTTER_GOOGLE_MAPS_API_KEY || process.env.GOOGLE_API_KEY;
  if (!key) return res.status(500).json({ message: 'maps_key_missing' });
  const uri = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${encodeURIComponent(placeId)}&key=${key}&fields=formatted_address,address_components,geometry`;
  return https.get(uri, (r) => {
    let data = '';
    r.on('data', (chunk) => (data += chunk));
    r.on('end', () => {
      res.set('Content-Type', 'application/json');
      res.send(data);
    });
  }).on('error', (err) => {
    console.error('Places details proxy error:', err);
    res.status(502).json({ message: 'places_proxy_error' });
  });
});

// SSE token promotion: EventSource cannot send custom headers, so the frontend
// passes the JWT as ?token=<jwt>. Promote it to Authorization header here,
// BEFORE authMiddleware runs, so the standard middleware picks it up.
app.use((req: any, res: any, next: any) => {
  if (
    (req.path || '').includes('/events/stream') &&
    req.query.token &&
    !req.headers.authorization
  ) {
    req.headers.authorization = `Bearer ${req.query.token}`;
  }
  next();
});

// Public health + metrics endpoints (/api/health, /api/health/ready,
// /api/health/live, /api/metrics) — mounted at the /api prefix BEFORE
// authMiddleware so external uptime monitors + APM scrapers reach them without a
// session. Unmatched paths fall through to the authenticated routes below.
// /metrics is gated by METRICS_TOKEN.
const _healthRouter = require('express').Router();
require('./health').default(_healthRouter);
app.use('/api', _healthRouter);

// Configures the authentication middleware
// to set the currentUser to the requests
app.use(authMiddleware);

// Now that the user is known, enrich the request context so errors/slow queries
// captured downstream carry the userId.
app.use((req: any, _res: any, next: any) => {
  try {
    require('../lib/requestContext').enrichContext({ userId: req.currentUser?.id ?? null });
  } catch { /* best-effort */ }
  next();
});

// Middleware: allow selecting tenant by header `X-Tenant-Id` (optional)
app.use(require('../middlewares/tenantHeaderMiddleware').tenantFromHeaderMiddleware);

// Setup the Documentation
setupSwaggerUI(app);

// Default rate limiter — the app-wide backstop. Keyed per user token (not
// just per IP) so an office of operators behind one NAT never shares a single
// bucket, and /auth/me is exempt so a throttled client still hydrates its
// session instead of looking logged out (Ecuaseguridad outage, 2026-07-09).
// Sign-in/sign-up keep their own stricter per-IP limiters.
const defaultRateLimiter = createRateLimiter({
  name: 'default',
  max: Number(process.env.RATE_LIMIT_DEFAULT_MAX) || 1500,
  windowMs: 15 * 60 * 1000,
  message: 'errors.429',
  keyByAuth: true,
  skipPaths: ['/auth/me'],
});
app.use(defaultRateLimiter);

// Enables Helmet, a set of tools to
// increase security.
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" },
  crossOriginEmbedderPolicy: false
}));

// Parses the body of POST/PUT request
// to JSON
app.use(
  bodyParser.json({
    verify: function (req, res, buf) {
      // Always capture raw body for debugging purposes. This helps
      // diagnose JSON parse errors originating from malformed client payloads.
      try {
        (<any>req).rawBody = buf && buf.toString ? buf.toString() : '';
      } catch (e) {
        (<any>req).rawBody = '';
      }
    },
  }),
);

// Parse multipart/form-data for import endpoints so frontends
// that send FormData (files or JSON fields) can provide the
// `data` and `importHash` fields as text form fields or upload files.
// Limits are mandatory: bare multer() is memoryStorage with fileSize=Infinity
// and no file-count cap, so a single unauthenticated POST to any */import URL
// could buffer gigabytes on the heap of the box shared with MySQL.
const multipartParser = multer({
  limits: {
    fileSize: 20 * 1024 * 1024,
    files: 5,
    fields: 100,
    fieldSize: 1024 * 1024,
  },
});
// Dedicated limiter for import posts. Built with express-rate-limit directly
// because createRateLimiter's shared skip exempts every URL ending in
// '/import', so a limiter built there would never fire on these routes.
// Budget is generous on purpose: the CRM importers post ONE request PER ROW
// (see frontend visitorLogService.import), so a big CSV is thousands of
// legitimate posts — this is an abuse backstop, not a throttle. Keyed per
// user (not per IP) so offices behind one NAT don't share a bucket.
const importRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.RATE_LIMIT_IMPORT_MAX) || 2000,
  message: 'errors.429',
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: any) => String(req.currentUser?.id || req.ip),
  validate: false as any,
});
app.use((req: any, res, next) => {
  if (
    req.originalUrl &&
    (req.originalUrl.endsWith('/import') || req.originalUrl.endsWith('/import-file')) &&
    req.method === 'POST'
  ) {
    // Every import route is authenticated + permissioned downstream, but
    // authMiddleware passes tokenless requests through — reject them HERE,
    // before any multipart bytes are buffered into memory.
    if (!req.currentUser) {
      return ApiResponseHandler.error(req, res, new Error401());
    }
    return importRateLimiter(req, res, () => {
      // Accept both fields and files for import endpoints (supports both
      // `/import` and `/import-file` route suffixes). Multer limit violations
      // surface as MulterError via next(err) → translate to 413/400 instead of
      // the terminal handler's generic 500.
      multipartParser.any()(req, res, (err) => {
        if (!err) {
          return next();
        }
        const tooLarge = err.code === 'LIMIT_FILE_SIZE';
        return res.status(tooLarge ? 413 : 400).json({
          message: tooLarge ? 'File too large' : 'Upload failed',
          code: tooLarge ? 413 : 400,
        });
      });
    });
  }
  return next();
});

// Configure the Entity routes
const routes = express.Router();

// Enable Passport for Social Sign-in
authSocial(app, routes);

// Loads the Tenant if the :tenantId param is passed
// IMPORTANT: This MUST be before the route definitions
routes.param('tenantId', tenantMiddleware);

require('./auditLog').default(routes);
require('./auth').default(routes);
require('./plan').default(routes);
require('./tenant').default(routes);
require('./file').default(routes);
require('./user').default(routes);
require('./settings').default(routes);
require('./department').default(routes);
require('./dashboard').default(routes);
require('./role').default(routes);
require('./bannerSuperiorApp').default(routes);
require('./service').default(routes);
require('./certification').default(routes);
require('./securityGuard').default(routes);
require('./supervisorProfile').default(routes);
require('./supervisorPosition').default(routes);
require('./feedback').default(routes);
require('./performance').default(routes);
require('./clientAccount').default(routes);
require('./clientProject').default(routes);
require('./category').default(routes);
require('./licenseType').default(routes);
require('./incident').default(routes);
require('./incidentType').default(routes);
require('./inventory').default(routes);
require('./inventoryItem').default(routes);
require('./inventoryAssignment').default(routes);
require('./patrol').default(routes);
require('./payroll').default(routes);
require('./visitorLog').default(routes);
require('./visitorPreAuth').default(routes);
require('./guardRating').default(routes);
require('./station').default(routes);
require('./stationOrder').default(routes);
require('./billing').default(routes);
require('./payment').default(routes);
require('./customer').default(routes);
require('./task').default(routes);
require('./passdown').default(routes);
require('./notification').default(routes);
require('./guardDevice').default(routes);
require('./guardShift').default(routes);
require('./attendance').default(routes);
require('./memos').default(routes);
require('./request').default(routes);
// Comments endpoints (in-memory, replace with DB-backed implementation as needed)
require('./request/comments').default(routes);
require('./timeOffRequest').default(routes);
require('./shiftExchangeRequest').default(routes);
require('./shiftTemplate').default(routes);
require('./radioDevice').default(routes);
  require('./radio').default(routes);
// Mounted on `routes` (under /api + tenantId membership validation) — it was
// previously mounted on `app`, so the CRM's POST /api/tenant/:id/client-log
// 404'd and client-side error telemetry never arrived.
require('./clientLog').default(routes);
require('./inventoryHistory').default(routes);
require('./businessInfo').default(routes);
require('./postSite').default(routes);
require('./vehicle').default(routes);
require('./route').default(routes);
require('./routeRun').default(routes);
require('./supervisor').default(routes);
require('./staff').default(routes);
require('./geocode').default(routes);
require('./siteTour').default(routes);
require('./rondaSettings').default(routes);
require('./emailPreferences').default(routes);
require('./notificationPreferences').default(routes);
require('./smsAccount').default(routes);
require('./subscription').default(routes);
require('./kpi').default(routes);
require('./operations').default(routes);
require('./video').default(routes);
require('./alarm').default(routes);
require('./security').default(routes);
require('./shift').default(routes);
require('./scheduler').default(routes);
require('./scheduling').default(routes);
require('./guard').default(routes);
require('./message').default(routes);
require('./radioCheck').default(routes);
require('./communication').default(routes);
require('./events').default(routes);
require('./training').default(routes);
require('./trainingGuard').default(routes);
require('./superadmin').default(routes);

// CRUD endpoints for tenant_user_client_accounts
app.get('/api/tenant-user-client-accounts', tenantUserClientAccounts.listTenantUserClientAccounts);
app.post('/api/tenant-user-client-accounts', tenantUserClientAccounts.createTenantUserClientAccount);
app.delete('/api/tenant-user-client-accounts/:id', tenantUserClientAccounts.deleteTenantUserClientAccount);

// (Removed dead CRUD for the duplicate `tenant_user_postsite` table — Phase 0
//  cleanup. The canonical pivot is `tenant_user_post_sites`.)

// Add the routes to the /api endpoint
app.use('/api', routes);

// JSON parse error handler: log raw body and return a helpful 400
app.use((err: any, req: any, res: any, next: any) => {
  if (err && (err instanceof SyntaxError || err.type === 'entity.parse.failed' || /Unexpected token|Expected double-quoted property name/.test(String(err.message || '')))) {
    try {
      console.error('[ERROR] JSON parse failed for', req.method, req.originalUrl, 'rawBody=', req.rawBody);
    } catch (e) {}
    return res.status(400).json({ message: 'Invalid JSON body', details: err.message });
  }
  return next(err);
});

// Terminal safety net: any error reaching here (a handler that threw without its
// own try/catch, or one that called next(err)) is normalized through
// ApiResponseHandler — structured 4xx body for typed errors, generic 500
// otherwise — instead of Express's default HTML stack-trace leak.
app.use((err: any, req: any, res: any, next: any) => {
  if (res.headersSent) {
    return next(err);
  }
  try {
    return ApiResponseHandler.error(req, res, err);
  } catch (e) {
    return res.status(500).json({ message: 'Internal server error', code: 500 });
  }
});

export default app;
