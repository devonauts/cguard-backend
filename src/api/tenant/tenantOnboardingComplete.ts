import ApiResponseHandler from '../apiResponseHandler';
import Error403 from '../../errors/Error403';
import Error404 from '../../errors/Error404';
import PermissionChecker from '../../services/user/permissionChecker';
import Permissions from '../../security/permissions';

export default async (req, res, next) => {
  try {
    /** @openapi { "summary": "Mark tenant onboarding as completed", "parameters": [ { "name": "tenantId", "in": "path", "required": true, "schema": { "type": "string" } } ], "responses": { "200": { "description": "Onboarding completed" }, "403": { "description": "Forbidden" }, "404": { "description": "Tenant not found" } } } */

    if (!req.currentUser || !req.currentUser.id) {
      throw new Error403(req.language);
    }

    const tenantId = req.params.tenantId;

    // Validate the user has admin-level tenant edit permission on this tenant.
    new PermissionChecker({
      currentUser: req.currentUser,
      currentTenant: { id: tenantId },
      language: req.language,
    }).validateHas(Permissions.values.tenantEdit);

    const record = await req.database.tenant.findByPk(tenantId);

    if (!record) {
      throw new Error404();
    }

    await record.update({ onboardingCompleted: true });

    await ApiResponseHandler.success(req, res, {
      success: true,
      onboardingCompleted: true,
    });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
