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

  // Domain route modules (each: export default (router) => { router.get(...) }).
  require('./dashboard').default(router);
  require('./tenants').default(router);
  require('./billing').default(router);
  require('./users').default(router);
  require('./observability').default(router);
  require('./settings').default(router);
  require('./trainingAddon').default(router);

  app.use('/superadmin', router);
};
