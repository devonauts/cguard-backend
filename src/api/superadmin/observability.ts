/**
 * SuperAdmin · observability + audit routes.
 * Mounted under /api/superadmin by ./index.ts, behind requireSuperadmin.
 *
 * Thin route layer — all logic lives in observabilityService.ts. Payloads are
 * returned DIRECTLY via ApiResponseHandler.success (no { success, data } wrap).
 * Also hosts GET /audit (the platform audit-log feed).
 */
import ApiResponseHandler from '../apiResponseHandler';
import {
  health,
  stats,
  auditLog,
  system,
  dbPerformance,
  jobs,
  slowQueries,
  resetSlowQueries,
  workers,
  errors,
  errorDetail,
  resolveError,
  systemHistory,
  alerts,
  dbTables,
  dbProcessList,
  authEvents,
  lockedAccounts,
  accountAction,
  explainQuery,
  queues,
  queuesRetry,
  queuesDrain,
} from '../../services/superadmin/observabilityService';

export default (router) => {
  const route = (path: string, fn: (req: any) => Promise<any>) =>
    router.get(path, async (req: any, res: any) => {
      try {
        await ApiResponseHandler.success(req, res, await fn(req));
      } catch (error) {
        await ApiResponseHandler.error(req, res, error);
      }
    });

  route('/observability/system', system);
  route('/observability/db', dbPerformance);
  route('/observability/jobs', jobs);
  route('/observability/slow-queries', slowQueries);
  route('/observability/workers', workers);
  route('/observability/errors', errors);
  route('/observability/errors/:fingerprint', errorDetail);
  route('/observability/system/history', systemHistory);
  route('/observability/alerts', alerts);
  route('/observability/db/tables', dbTables);
  route('/observability/db/processlist', dbProcessList);
  route('/observability/auth-events', authEvents);
  route('/observability/locked-accounts', lockedAccounts);
  route('/observability/queues', queues);

  router.post('/observability/queues/retry', async (req: any, res: any) => {
    try { await ApiResponseHandler.success(req, res, await queuesRetry(req)); }
    catch (error) { await ApiResponseHandler.error(req, res, error); }
  });
  router.post('/observability/queues/drain', async (req: any, res: any) => {
    try { await ApiResponseHandler.success(req, res, await queuesDrain(req)); }
    catch (error) { await ApiResponseHandler.error(req, res, error); }
  });

  router.post('/observability/explain', async (req: any, res: any) => {
    try { await ApiResponseHandler.success(req, res, await explainQuery(req)); }
    catch (error) { await ApiResponseHandler.error(req, res, error); }
  });

  router.post('/observability/accounts/action', async (req: any, res: any) => {
    try { await ApiResponseHandler.success(req, res, await accountAction(req)); }
    catch (error) { await ApiResponseHandler.error(req, res, error); }
  });

  router.post('/observability/errors/resolve', async (req: any, res: any) => {
    try {
      await ApiResponseHandler.success(req, res, await resolveError(req));
    } catch (error) {
      await ApiResponseHandler.error(req, res, error);
    }
  });

  router.delete('/observability/slow-queries', async (req: any, res: any) => {
    try {
      await ApiResponseHandler.success(req, res, await resetSlowQueries(req));
    } catch (error) {
      await ApiResponseHandler.error(req, res, error);
    }
  });

  router.get('/observability/health', async (req, res) => {
    try {
      const payload = await health(req);
      await ApiResponseHandler.success(req, res, payload);
    } catch (error) {
      await ApiResponseHandler.error(req, res, error);
    }
  });

  router.get('/observability/stats', async (req, res) => {
    try {
      const payload = await stats(req);
      await ApiResponseHandler.success(req, res, payload);
    } catch (error) {
      await ApiResponseHandler.error(req, res, error);
    }
  });

  router.get('/audit', async (req, res) => {
    try {
      const payload = await auditLog(req);
      await ApiResponseHandler.success(req, res, payload);
    } catch (error) {
      await ApiResponseHandler.error(req, res, error);
    }
  });
};
