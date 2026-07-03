/**
 * SuperAdmin · sandbox provisioning routes. Mounted under /api/superadmin behind
 * requireSuperadmin. Creates a fresh, prospect-branded, fully-populated TRIAL
 * tenant for sales to hand to a lead. Audited.
 */
import ApiResponseHandler from '../apiResponseHandler';
import { writeAudit } from '../../services/superadmin/superadminHelpers';
import { provisionSandbox } from '../../services/demo/sandboxProvisioner';

export default (router) => {
  // POST /sandboxes — create a branded demo sandbox. Body: { brandName, ownerEmail?, ownerFullName? }
  router.post('/sandboxes', async (req, res) => {
    try {
      const { brandName, ownerEmail, ownerFullName, sendCredentialsTo } = req.body || {};
      const result = await provisionSandbox(req.database, {
        brandName,
        ownerEmail,
        ownerFullName,
        sendCredentialsTo,
      });
      await writeAudit(req, {
        action: 'sandbox.create',
        targetType: 'tenant',
        targetId: result.tenantId,
        tenantId: result.tenantId,
        statusCode: 200,
        details: { brandName, slug: result.slug, emailedTo: result.emailedTo || null, emailSent: result.emailSent || false },
      });
      await ApiResponseHandler.success(req, res, result);
    } catch (error) {
      await ApiResponseHandler.error(req, res, error);
    }
  });
};
