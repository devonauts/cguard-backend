/**
 * Platform SuperAdmin API — mounted under `/api/superadmin`.
 *
 * Every route here is gated by `requireSuperadmin` (checked once, centrally),
 * which runs after the global authMiddleware. Routes are split by domain into
 * sibling modules; each registers its own paths on the router passed in.
 *
 * NOTE: this is a brand-new, schema-correct module. The older orphaned
 * `src/superadmin/` module is intentionally left untouched and is NOT mounted.
 */
import { Router } from 'express';
import { requireSuperadmin } from '../../middlewares/superadminMiddleware';

export default (app) => {
  const router = Router();

  // Gate: only platform superadmins past this point.
  router.use(requireSuperadmin);

  // Auto-audit: every state-changing (non-GET) superadmin request is logged by
  // default, so new routes are audited by construction. Routes that call
  // writeAudit() explicitly set req._audited and are skipped here (no double
  // log). Recorded on response finish so we capture the real status code.
  router.use((req: any, res: any, next: any) => {
    if (req.method === 'GET' || req.method === 'OPTIONS' || req.method === 'HEAD') return next();
    res.on('finish', () => {
      try {
        if (req._audited) return; // already logged explicitly with richer detail
        if (res.statusCode >= 400) { /* still log failures — they matter */ }
        const action = `${req.method} ${String(req.path || req.originalUrl || '').split('?')[0]}`.slice(0, 200);
        require('../../services/superadmin/superadminHelpers')
          .writeAudit(req, { action, statusCode: res.statusCode })
          .catch(() => {});
      } catch { /* best-effort */ }
    });
    next();
  });

  // Domain route modules (each: export default (router) => { router.get(...) }).
  require('./dashboard').default(router);
  require('./tenants').default(router);
  require('./plans').default(router);
  require('./sandboxes').default(router);
  require('./billing').default(router);
  require('./users').default(router);
  require('./observability').default(router);
  require('./feedback').default(router);
  require('./settings').default(router);
  require('./trainingAddon').default(router);
  require('./twilio').default(router);
  require('./notifications').default(router);
  require('./broadcastPush').default(router);
  require('./demo').default(router);

  app.use('/superadmin', router);
};
