import express from 'express';
import cors from 'cors';
import { authMiddleware } from '../middlewares/authMiddleware';
import { tenantMiddleware } from '../middlewares/tenantMiddleware';
import { databaseMiddleware } from '../middlewares/databaseMiddleware';
import bodyParser from 'body-parser';
import multer from 'multer';
import helmet from 'helmet';
import { createRateLimiter } from './apiRateLimiter';
import { languageMiddleware } from '../middlewares/languageMiddleware';
import authSocial from './auth/authSocial';
import setupSwaggerUI from './apiDocumentation';

const app = express();

// Enables CORS
app.use(cors({ origin: true, credentials: true }));

// Initializes and adds the database middleware.
app.use(databaseMiddleware);

// Sets the current language of the request
app.use(languageMiddleware);

// Configures the authentication middleware
// to set the currentUser to the requests
app.use(authMiddleware);

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
      const url = (<any>req).originalUrl;
      if (url.startsWith('/api/plan/stripe/webhook')) {
        // Stripe Webhook needs the body raw in order
        // to validate the request
        (<any>req).rawBody = buf.toString();
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
    req.originalUrl.endsWith('/import') &&
    req.method === 'POST'
  ) {
    // Accept both fields and files for import endpoints
    return multipartParser.any()(req, res, next);
  }
  return next();
});

// Configure the Entity routes
const routes = express.Router();

// Enable Passport for Social Sign-in
authSocial(app, routes);

require('./auditLog').default(routes);
require('./auth').default(routes);
require('./plan').default(routes);
require('./tenant').default(routes);
require('./file').default(routes);
require('./user').default(routes);
require('./settings').default(routes);
require('./dashboard').default(routes);
require('./bannerSuperiorApp').default(routes);
require('./service').default(routes);
require('./certification').default(routes);
require('./securityGuard').default(routes);
require('./clientAccount').default(routes);
require('./category').default(routes);
require('./representanteEmpresa').default(routes);
require('./incident').default(routes);
require('./inventory').default(routes);
require('./additionalService').default(routes);
require('./patrolCheckpoint').default(routes);
require('./patrolLog').default(routes);
require('./patrol').default(routes);
require('./station').default(routes);
require('./billing').default(routes);
require('./inquiries').default(routes);
require('./task').default(routes);
require('./notification').default(routes);
require('./deviceIdInformation').default(routes);
require('./guardShift').default(routes);
require('./memos').default(routes);
require('./request').default(routes);
require('./videoTutorialCategory').default(routes);
require('./videoTutorial').default(routes);
require('./tutorial').default(routes);
require('./completionOfTutorial').default(routes);
require('./inventoryHistory').default(routes);
require('./businessInfo').default(routes);
require('./postSite').default(routes);
require('./insurance').default(routes);
require('./notificationRecipient').default(routes);
require('./report').default(routes);
require('./shift').default(routes);

// Loads the Tenant if the :tenantId param is passed
routes.param('tenantId', tenantMiddleware);

// Add the routes to the /api endpoint
app.use('/api', routes);

export default app;
