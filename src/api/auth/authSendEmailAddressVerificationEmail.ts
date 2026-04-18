/** @openapi { "summary": "Send email address verification email (for current user)", "requestBody": { "content": { "application/json": { "schema": { "type": "object", "properties": { "tenantId": { "type": "string" } } } } } }, "responses": { "200": { "description": "Email sent" }, "403": { "description": "Forbidden" } } } */

import ApiResponseHandler from '../apiResponseHandler';
import Error403 from '../../errors/Error403';

import AuthService from '../../services/auth/authService';

export default async (req, res, next) => {
  try {
    if (!req.currentUser) {
      throw new Error403(req.language);
    }

    await AuthService.sendEmailAddressVerificationEmail(
      req.language,
      req.currentUser.email,
      req.body.tenantId,
      req,
    );

    const payload = true;

    await ApiResponseHandler.success(req, res, payload);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
