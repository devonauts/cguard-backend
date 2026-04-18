import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import BusinessInfoService from '../../services/businessInfoService';

export default async (req, res, next) => {
  try {
    new PermissionChecker(req).validateHas(
      Permissions.values.businessInfoCreate,
    );

    const input = req.body.data || req.body || {};

    // support payload variants: maybe frontend sends `postSite`, `data.postSite`, or raw fields
    const source = input.postSite || input.data || input;

    const find = (keys, fallback) => {
      for (const k of keys) {
        if (source && (source[k] !== undefined && source[k] !== null)) {
          return source[k];
        }
      }

      // also check top-level input for some keys
      for (const k of keys) {
        if (input && (input[k] !== undefined && input[k] !== null)) {
          return input[k];
        }
      }

      return fallback;
    };

    const mapped = {
      companyName: find(['companyName', 'name', 'postSiteName'], null),
      description: find(['description', 'notes', 'postSiteNotes', 'name'], null),
      contactPhone: find(['contactPhone', 'phone', 'phoneNumber', 'contactPhoneAlt'], null),
      contactEmail: find(['contactEmail', 'email', 'contactEmailAlt'], null),
      address: find(['address', 'location', 'street'], null),
      latitud: find(['latitud', 'latitude'], null),
      longitud: find(['longitud', 'longitude'], null),
      categoryIds: find(['categoryIds'], []),
      active: find(['active'], true),
      importHash: find(['importHash'], undefined),
      logo: find(['logo'], undefined),
      clientAccountId: find(['clientAccountId', 'clientId'], undefined),
      secondAddress: find(['secondAddress', 'addressComplement'], undefined),
      country: find(['country'], undefined),
      city: find(['city'], undefined),
      postalCode: find(['postalCode', 'postal_code'], undefined),
    };

    // Validate required fields — return 400 instead of saving placeholders
    const required = [
      'companyName',
      'description',
      'contactPhone',
      'contactEmail',
      'address',
    ];

    const placeholders = new Set([
      'Sin nombre',
      'Sin descripción',
      'Sin teléfono',
      'sin-email@local.invalid',
      'Sin dirección',
    ]);

    const missing = required.filter((k) => {
      const v = mapped[k];
      return (
        v === undefined ||
        v === null ||
        (typeof v === 'string' && v.trim() === '') ||
        placeholders.has(v)
      );
    });

    if (missing.length) {
      console.error('businessInfo.create missing fields, payload keys:', Object.keys(input || {}));
      const err: any = new Error(`Missing required fields: ${missing.join(', ')}`);
      err.code = 400;
      return await ApiResponseHandler.error(req, res, err);
    }

    const payload = await new BusinessInfoService(req).create(
      mapped,
    );

    await ApiResponseHandler.success(req, res, payload);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
