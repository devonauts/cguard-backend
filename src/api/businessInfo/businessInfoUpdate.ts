/** @openapi { "summary": "Update business info", "description": "Update a post site (business info).", "requestBody": { "content": { "application/json": { "schema": { "type": "object", "properties": { "companyName": { "type": "string" }, "description": { "type": "string" }, "contactPhone": { "type": "string" }, "contactEmail": { "type": "string", "format": "email" }, "address": { "type": "string" }, "latitud": { "type": "number" }, "longitud": { "type": "number" }, "categoryIds": { "type": "array", "items": { "type": "string" } }, "active": { "type": "boolean" }, "serviceType": { "type": "string", "enum": ["manned","alarm","cctv","patrol","custody"] }, "logo": { "type": "string" }, "clientAccountId": { "type": "string" }, "secondAddress": { "type": "string" }, "country": { "type": "string" }, "city": { "type": "string" }, "postalCode": { "type": "string" } } } } } }, "responses": { "200": { "description": "Updated" }, "400": { "description": "Validation error" } } } */

import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import BusinessInfoService from '../../services/businessInfoService';

export default async (req, res, next) => {
  try {
    new PermissionChecker(req).validateHas(
      Permissions.values.businessInfoEdit,
    );

    const raw = req.body.data || req.body || {};

    // Normalize field aliases so either camelCase variant works
    const find = (keys: string[], fallback: any = undefined) => {
      for (const k of keys) {
        if (raw[k] !== undefined && raw[k] !== null) return raw[k];
      }
      return fallback;
    };

    const mapped: any = {};

    const companyName = find(['companyName', 'name', 'stationName']);
    if (companyName !== undefined) mapped.companyName = companyName;

    const description = find(['description']);
    if (description !== undefined) mapped.description = description;

    const contactPhone = find(['contactPhone', 'phone', 'phoneNumber']);
    if (contactPhone !== undefined) mapped.contactPhone = contactPhone;

    const contactEmail = find(['contactEmail', 'email']);
    if (contactEmail !== undefined) mapped.contactEmail = contactEmail;

    const address = find(['address', 'location', 'street']);
    if (address !== undefined) mapped.address = address;

    const secondAddress = find(['secondAddress', 'addressLine2', 'addressComplement']);
    if (secondAddress !== undefined) mapped.secondAddress = secondAddress;

    const city = find(['city']);
    if (city !== undefined) mapped.city = city;

    const country = find(['country']);
    if (country !== undefined) mapped.country = country;

    const postalCode = find(['postalCode', 'zipCode', 'postal_code']);
    if (postalCode !== undefined) mapped.postalCode = postalCode;

    const latitud = find(['latitud', 'latitude']);
    if (latitud !== undefined) mapped.latitud = latitud;

    const longitud = find(['longitud', 'longitude']);
    if (longitud !== undefined) mapped.longitud = longitud;

    const categoryIds = find(['categoryIds']);
    if (categoryIds !== undefined) mapped.categoryIds = categoryIds;

    const clientAccountId = find(['clientAccountId', 'clientId']);
    if (clientAccountId !== undefined) mapped.clientAccountId = clientAccountId;

    const serviceType = find(['serviceType']);
    if (serviceType !== undefined) mapped.serviceType = serviceType;

    const fax = find(['fax']);
    if (fax !== undefined) mapped.fax = fax;

    const logo = find(['logo']);
    if (logo !== undefined) mapped.logo = logo;

    // active: accept boolean or string 'active'/'inactive'
    const activeRaw = find(['active', 'status']);
    if (activeRaw !== undefined) {
      if (typeof activeRaw === 'boolean') mapped.active = activeRaw;
      else if (typeof activeRaw === 'string') mapped.active = activeRaw === 'active';
    }

    const stationSchedule = find(['stationSchedule']);
    if (stationSchedule !== undefined) mapped.stationSchedule = stationSchedule;

    const startingTimeInDay = find(['startingTimeInDay']);
    if (startingTimeInDay !== undefined) mapped.startingTimeInDay = startingTimeInDay;

    const finishTimeInDay = find(['finishTimeInDay']);
    if (finishTimeInDay !== undefined) mapped.finishTimeInDay = finishTimeInDay;

    const payload = await new BusinessInfoService(req).update(
      req.params.id,
      mapped,
    );

    await ApiResponseHandler.success(req, res, payload);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};

