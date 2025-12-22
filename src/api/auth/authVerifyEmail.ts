import ApiResponseHandler from '../apiResponseHandler';
import AuthService from '../../services/auth/authService';

export default async (req, res, next) => {
  try {
    const token = req.body && req.body.token ? req.body.token : req.query && req.query.token ? req.query.token : undefined;
    const payload = await AuthService.verifyEmail(
      token,
      req,
    );

    await ApiResponseHandler.success(req, res, payload);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
