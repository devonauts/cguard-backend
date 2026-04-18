/** @openapi { "summary": "Update client account", "description": "Update an existing client account.", "requestBody": { "content": { "application/json": { "schema": { "type": "object", "properties": { "name": { "type": "string" }, "lastName": { "type": "string" }, "email": { "type": "string", "format": "email" }, "phoneNumber": { "type": "string" }, "address": { "type": "string" }, "addressComplement": { "type": "string" }, "zipCode": { "type": "string" }, "city": { "type": "string" }, "country": { "type": "string" }, "faxNumber": { "type": "string" }, "website": { "type": "string" }, "categoryIds": { "type": "array", "items": { "type": "string" } }, "active": { "type": "boolean" }, "latitude": { "type": "number" }, "longitude": { "type": "number" } } } } } }, "responses": { "200": { "description": "Updated" }, "400": { "description": "Validation error" } } } */

import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import ClientAccountService from '../../services/clientAccountService';

export default async (req, res, next) => {
  try {
    new PermissionChecker(req).validateHas(
      Permissions.values.clientAccountEdit,
    );

    // Mapear nombres de campos del frontend al backend
    const rawData = req.body.data || req.body;
    console.log('🔍 Raw data recibida del frontend:', rawData);
    console.log('🔍 Active recibido:', rawData.active);

    const parseDecimal = (value) => {
      if (value === undefined || value === null || value === '') {
        return null;
      }
      const s = String(value).replace(',', '.');
      const n = parseFloat(s);
      return Number.isFinite(n) ? n : null;
    };

    const data = {
      ...rawData,
      // Mapear addressLine2 -> addressComplement
      addressComplement: rawData.addressLine2 || rawData.addressComplement,
      // Mapear postalCode -> zipCode
      zipCode: rawData.postalCode || rawData.zipCode,
      // Keep categoryIds array for N:N relationship
      categoryIds: rawData.categoryIds || [],
      // Mapear y sanear lat/long
      latitude: parseDecimal(rawData.latitude ?? rawData.latitud ?? rawData.lat),
      longitude: parseDecimal(rawData.longitude ?? rawData.longitud ?? rawData.lng),
    };

    console.log('📝 Data mapeada:', data);
    console.log('📝 Active mapeado:', data.active);
    console.log('📝 CategoryIds:', data.categoryIds);

    // Remover campos del frontend que no existen en el modelo
    delete data.addressLine2;
    delete data.postalCode;

    const payload = await new ClientAccountService(req).update(
      req.params.id,
      data,
    );

    await ApiResponseHandler.success(req, res, payload);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
