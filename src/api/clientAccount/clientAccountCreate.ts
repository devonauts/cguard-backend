import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import ClientAccountService from '../../services/clientAccountService';

export default async (req, res, next) => {
  try {
    new PermissionChecker(req).validateHas(
      Permissions.values.clientAccountCreate,
    );

    console.log('📥 req.body ORIGINAL:', JSON.stringify(req.body, null, 2));

    // Mapear nombres de campos del frontend al backend
    const data = {
      ...req.body,
      // Mapear addressLine2 -> addressComplement
      addressComplement: req.body.addressLine2 || req.body.addressComplement,
      // Mapear postalCode -> zipCode
      zipCode: req.body.postalCode || req.body.zipCode,
    };

    // Remover campos del frontend que no existen en el modelo
    delete data.addressLine2;
    delete data.postalCode;

    console.log('📤 Data MAPEADA que se enviará al servicio:', JSON.stringify(data, null, 2));

    const payload = await new ClientAccountService(req).create(data);

    console.log('✅ Payload GUARDADO en BD:', JSON.stringify(payload, null, 2));

    await ApiResponseHandler.success(req, res, payload);
  } catch (error) {
    console.error('❌ Error al crear cliente:', error);
    await ApiResponseHandler.error(req, res, error);
  }
};
