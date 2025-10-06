import AuthService from '../services/auth/authService';
import ApiResponseHandler from '../api/apiResponseHandler';
import Error401 from '../errors/Error401';

/**
 * Authenticates and fills the request with the user if it exists.
 * If no token is passed, it continues the request but without filling the currentUser.
 * If userAutoAuthenticatedEmailForTests exists and no token is passed, it fills with this user for tests.
 */
export async function authMiddleware(req, res, next) {
  // Allow signup and signin routes without authentication
  const publicRoutes = ['/api/auth/sign-up', '/api/auth/sign-in', '/api/auth/send-password-reset-email'];
  if (publicRoutes.some(route => req.path === route)) {
    return next();
  }

  const isTokenEmpty =
    (!req.headers.authorization ||
      !req.headers.authorization.startsWith('Bearer ')) &&
    !(req.cookies && req.cookies.__session);

  if (isTokenEmpty) {
    return next();
  }

  let idToken;

  if (
    req.headers.authorization &&
    req.headers.authorization.startsWith('Bearer ')
  ) {
    // Read the ID Token from the Authorization header.
    idToken = req.headers.authorization.split('Bearer ')[1];
    console.log('🔍 Auth middleware - Bearer token found:', idToken?.substring(0, 20) + '...');
  } else if (req.cookies) {
    // Read the ID Token from cookie.
    idToken = req.cookies.__session;
    console.log('🔍 Auth middleware - Cookie token found:', idToken?.substring(0, 20) + '...');
  } else {
    console.log('🔍 Auth middleware - No token found, continuing without auth');
    return next();
  }

  try {
    console.log('🔍 Auth middleware - Validating token with AuthService...');
    const currentUser: any = await AuthService.findByToken(
      idToken,
      req,
    );
    console.log('✅ Auth middleware - User found:', currentUser?.id, currentUser?.email);
    req.currentUser = currentUser;

    return next();
  } catch (error) {
    console.error('❌ Auth middleware - Token validation failed:', error);
    await ApiResponseHandler.error(
      req,
      res,
      new Error401(),
    );
  }
}
