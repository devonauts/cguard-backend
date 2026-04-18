import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
/** @openapi { "summary": "Create client account", "description": "Creates a new client account for the tenant.", "requestBody": { "content": { "application/json": { "schema": { "type": "object", "properties": { "name": { "type": "string" }, "lastName": { "type": "string" }, "email": { "type": "string", "format": "email" }, "phoneNumber": { "type": "string" }, "address": { "type": "string" }, "addressComplement": { "type": "string" }, "zipCode": { "type": "string" }, "city": { "type": "string" }, "country": { "type": "string" }, "faxNumber": { "type": "string" }, "website": { "type": "string" }, "categoryIds": { "type": "array", "items": { "type": "string" } }, "active": { "type": "boolean" }, "importHash": { "type": "string" }, "latitude": { "type": "number" }, "longitude": { "type": "number" } }, "required": [ "name", "address" ] } } } }, "responses": { "200": { "description": "Created" }, "400": { "description": "Validation error" } } } */
import ClientAccountService from '../../services/clientAccountService';

export default async (req, res, next) => {
  try {
    new PermissionChecker(req).validateHas(
      Permissions.values.clientAccountCreate,
    );

    console.log('📥 req.body ORIGINAL:', JSON.stringify(req.body, null, 2));

    // Función auxiliar para parsear decimales y convertir valores vacíos a null
    const parseDecimal = (value) => {
      if (value === undefined || value === null || value === '') {
        return null;
      }
      const s = String(value).replace(',', '.');
      const n = parseFloat(s);
      return Number.isFinite(n) ? n : null;
    };

    // Mapear nombres de campos del frontend al backend
    const data = {
      ...req.body,
      // Mapear addressLine2 -> addressComplement
      addressComplement: req.body.addressLine2 || req.body.addressComplement,
      // Mapear postalCode -> zipCode
      zipCode: req.body.postalCode || req.body.zipCode,
      // Keep categoryIds array for N:N relationship
      categoryIds: req.body.categoryIds || [],
      // Mapear latitud/longitud (posibles nombres en frontend) y sanear valores
      latitude: parseDecimal(req.body.latitude ?? req.body.latitud ?? req.body.lat),
      longitude: parseDecimal(req.body.longitude ?? req.body.longitud ?? req.body.lng),
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
