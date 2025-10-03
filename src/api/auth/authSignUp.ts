import ApiResponseHandler from '../apiResponseHandler';
import AuthService from '../../services/auth/authService';

export default async (req, res, next) => {
  try {
    console.log('🔵 Signup request received:');
    console.log('📧 Email:', req.body.email);
    console.log('🔐 Password provided:', !!req.body.password);
    console.log('🎫 Invitation token:', req.body.invitationToken);
    console.log('🏢 Tenant ID:', req.body.tenantId);

    const payload = await AuthService.signup(
      req.body.email,
      req.body.password,
      req.body.invitationToken,
      req.body.tenantId,
      req,
    );

    console.log('✅ Signup successful!');
    await ApiResponseHandler.success(req, res, payload);
  } catch (error) {
    console.log('❌ Signup error:', (error as Error).message);
    console.log('📊 Error stack:', (error as Error).stack);
    await ApiResponseHandler.error(req, res, error);
  }
};
