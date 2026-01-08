import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import TaxService from '../../services/taxService';

export default async (req, res, next) => {
  try {
    console.log('Tax create request params:', { params: req.params });
    console.log('Tax create request body:', JSON.stringify(req.body));
    new PermissionChecker(req).validateHas(
      Permissions.values.taxCreate,
    );

    const createData = req.body && req.body.data ? req.body.data : req.body;

    // Map frontend `status` to backend `active` boolean if provided
    if (createData && typeof createData.status !== 'undefined') {
      createData.active = String(createData.status).toLowerCase() === 'active';
      delete createData.status;
    }

    const payload = await new TaxService(req).create(
      createData,
    );

    await ApiResponseHandler.success(req, res, payload);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
