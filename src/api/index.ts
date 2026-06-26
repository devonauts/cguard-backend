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
import { createRateLimiter } from './apiRateLimiter';
import { languageMiddleware } from '../middlewares/languageMiddleware';
import authSocial from './auth/authSocial';
import setupSwaggerUI from './apiDocumentation';
import * as tenantUserClientAccounts from './tenantUserClientAccounts';

const app = express();

app.set('trust proxy', 1);
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

// Proxy endpoints for Google Places (server-side) to avoid CORS issues
app.get('/api/places/autocomplete', (req, res) => {
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

app.get('/api/places/details', (req, res) => {
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

// Configures the authentication middleware
// to set the currentUser to the requests
app.use(authMiddleware);

// Middleware: allow selecting tenant by header `X-Tenant-Id` (optional)
app.use(require('../middlewares/tenantHeaderMiddleware').tenantFromHeaderMiddleware);

// Setup the Documentation
setupSwaggerUI(app);

// Default rate limiter
const defaultRateLimiter = createRateLimiter({
  max: 500,
  windowMs: 15 * 60 * 1000,
  message: 'errors.429',
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
const multipartParser = multer();
app.use((req, res, next) => {
  if (
    req.originalUrl &&
    (req.originalUrl.endsWith('/import') || req.originalUrl.endsWith('/import-file')) &&
    req.method === 'POST'
  ) {
    // Accept both fields and files for import endpoints (supports both
    // `/import` and `/import-file` route suffixes).
    return multipartParser.any()(req, res, next);
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
require('./dashboard').default(routes);
require('./role').default(routes);
require('./bannerSuperiorApp').default(routes);
require('./service').default(routes);
require('./certification').default(routes);
require('./securityGuard').default(routes);
require('./performance').default(routes);
require('./clientAccount').default(routes);
require('./clientProject').default(routes);
require('./category').default(routes);
require('./licenseType').default(routes);
require('./representanteEmpresa').default(routes);
require('./incident').default(routes);
require('./incidentType').default(routes);
require('./inventory').default(routes);
require('./inventoryItem').default(routes);
require('./inventoryAssignment').default(routes);
require('./additionalService').default(routes);
require('./patrolCheckpoint').default(routes);
require('./patrolLog').default(routes);
require('./patrol').default(routes);
require('./visitorLog').default(routes);
require('./station').default(routes);
require('./stationOrder').default(routes);
require('./billing').default(routes);
require('./tax').default(routes);
require('./invoice').default(routes);
require('./estimate').default(routes);
require('./payment').default(routes);
require('./inquiries').default(routes);
require('./customer').default(routes);
require('./task').default(routes);
require('./notification').default(routes);
require('./deviceIdInformation').default(routes);
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
require('./clientLog').default(app);
require('./debug').default(routes);
require('./videoTutorialCategory').default(routes);
require('./videoTutorial').default(routes);
require('./tutorial').default(routes);
require('./completionOfTutorial').default(routes);
require('./inventoryHistory').default(routes);
require('./businessInfo').default(routes);
require('./postSite').default(routes);
require('./vehicle').default(routes);
require('./route').default(routes);
require('./routeRun').default(routes);
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
require('./insurance').default(routes);
require('./reports').default(routes);
require('./notificationRecipient').default(routes);
require('./report').default(routes);
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
