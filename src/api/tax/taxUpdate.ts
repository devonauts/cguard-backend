import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import TaxService from '../../services/taxService';

export default async (req, res, next) => {
  try {
    new PermissionChecker(req).validateHas(
      Permissions.values.taxEdit,
    );

    const updateData = req.body && req.body.data ? req.body.data : req.body;

    // Map frontend `status` to backend `active` boolean if provided
    if (typeof updateData.status !== 'undefined') {
      updateData.active = String(updateData.status).toLowerCase() === 'active';
      // remove status to avoid unknown field noise
      delete updateData.status;
    }

    const payload = await new TaxService(req).update(
      req.params.id,
      updateData,
    );

    await ApiResponseHandler.success(req, res, payload);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
