import ApiResponseHandler from '../apiResponseHandler'
import AuthService from '../../services/auth/authService'

export default async (req, res) => {
  try {
    const payload = await AuthService.signin(
      req.body.email,
      req.body.password,
      req.body.invitationToken,
      req.body.tenantId,
      req,
    )

    // ✅ RETORNO OBLIGATORIO para evitar doble respuesta
    return ApiResponseHandler.success(req, res, payload)

  } catch (error) {
    // ✅ RETORNO OBLIGATORIO para evitar doble respuesta
    return ApiResponseHandler.error(req, res, error)
  }
}
