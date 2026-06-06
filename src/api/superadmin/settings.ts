/**
 * SuperAdmin · platform settings routes (Stripe connection config).
 * Mounted under /api/superadmin by ./index.ts, behind requireSuperadmin.
 *
 * Secrets are write-only: GET never returns a secret key, only a "configured"
 * flag + last4. Logic lives in ../../services/stripe/stripeConfigService.
 */
import ApiResponseHandler from '../apiResponseHandler';
import {
  getStripeSettingsMasked,
  saveStripeSettings,
  testStripeConnection,
} from '../../services/stripe/stripeConfigService';
import { db } from '../../services/superadmin/superadminHelpers';

export default (router) => {
  // GET /settings/stripe — masked config for the UI.
  router.get('/settings/stripe', async (req, res) => {
    try {
      const payload = await getStripeSettingsMasked(db(req));
      await ApiResponseHandler.success(req, res, payload);
    } catch (error) {
      await ApiResponseHandler.error(req, res, error);
    }
  });

  // PUT /settings/stripe — upsert test/live keys + active mode.
  router.put('/settings/stripe', async (req, res) => {
    try {
      const payload = await saveStripeSettings(req, req.body || {});
      await ApiResponseHandler.success(req, res, payload);
    } catch (error) {
      await ApiResponseHandler.error(req, res, error);
    }
  });

  // POST /settings/stripe/test { mode } — verify the key authenticates.
  router.post('/settings/stripe/test', async (req, res) => {
    try {
      const mode = (req.body && req.body.mode) === 'live' ? 'live' : 'test';
      const payload = await testStripeConnection(req, mode);
      await ApiResponseHandler.success(req, res, payload);
    } catch (error) {
      await ApiResponseHandler.error(req, res, error);
    }
  });
};
