import passport from 'passport';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
import { Strategy as MicrosoftStrategy } from 'passport-microsoft';
import AuthService from '../../services/auth/authService';
import { databaseInit } from '../../database/databaseConnection';
import { get } from 'lodash';

/**
 * OAuth Popup Flow Handler
 * Maneja el flujo de autenticación OAuth2 con popup y postMessage al frontend
 * 
 * Flujo:
 * 1. Frontend abre popup a /auth/oauth/:provider
 * 2. Backend redirige a OAuth provider (Google/Microsoft)
 * 3. OAuth provider redirige a /auth/oauth/:provider/callback
 * 4. Backend autentica al usuario y renderiza HTML con postMessage
 * 5. El HTML manda el token/usuario al opener (frontend) via postMessage
 * 6. Frontend cierra el popup y navega
 */

export default (app) => {
  // Configurar estrategias Passport
  configureGoogleStrategy();
  configureMicrosoftStrategy();

  /**
   * GET /auth/oauth/google
   * Inicia flujo OAuth con Google
   */
  app.get(
    '/auth/oauth/google',
    passport.authenticate('google-oauth-popup', {
      scope: ['email', 'profile'],
      session: false,
    }),
  );

  /**
   * GET /auth/oauth/google/callback
   * Callback de Google OAuth
   */
  app.get('/auth/oauth/google/callback', (req, res, next) => {
    passport.authenticate('google-oauth-popup', (err, user) => {
      handleOAuthCallback(res, err, user);
    })(req, res, next);
  });

  /**
   * GET /auth/oauth/microsoft
   * Inicia flujo OAuth con Microsoft
   */
  app.get(
    '/auth/oauth/microsoft',
    passport.authenticate('microsoft-oauth-popup', {
      scope: ['email', 'profile'],
      session: false,
    }),
  );

  /**
   * GET /auth/oauth/microsoft/callback
   * Callback de Microsoft OAuth
   */
  app.get('/auth/oauth/microsoft/callback', (req, res, next) => {
    passport.authenticate('microsoft-oauth-popup', (err, user) => {
      handleOAuthCallback(res, err, user);
    })(req, res, next);
  });
};

/**
 * Configura estrategia Google para popup flow
 */
function configureGoogleStrategy() {
  if (
    !process.env.AUTH_SOCIAL_GOOGLE_CLIENT_ID ||
    !process.env.AUTH_SOCIAL_GOOGLE_CLIENT_SECRET
  ) {
    console.warn(
      'Google OAuth no configurado. Falta AUTH_SOCIAL_GOOGLE_CLIENT_ID o AUTH_SOCIAL_GOOGLE_CLIENT_SECRET',
    );
    return;
  }

  const googleCallbackUrl =
    process.env.AUTH_SOCIAL_GOOGLE_CALLBACK_URL ||
    `${process.env.BACKEND_URL}/auth/oauth/google/callback`;

  passport.use(
    'google-oauth-popup',
    new GoogleStrategy(
      {
        clientID: process.env.AUTH_SOCIAL_GOOGLE_CLIENT_ID,
        clientSecret: process.env.AUTH_SOCIAL_GOOGLE_CLIENT_SECRET,
        callbackURL: googleCallbackUrl,
      },
      async (accessToken, refreshToken, profile, done) => {
        try {
          const email = get(profile, 'emails[0].value');
          const emailVerified = get(profile, 'emails[0].verified', false);
          const displayName = get(profile, 'displayName', '');
          const picture = get(profile, 'photos[0].value', '');

          const { firstName, lastName } = splitFullName(displayName);

          const database = await databaseInit();

          // Autentica o crea usuario
          const result = await AuthService.signinFromSocial(
            'google',
            profile.id,
            email,
            emailVerified,
            firstName,
            lastName,
            { database },
          );

          // Obtiene datos del usuario para enviar al frontend
          const user = await database.user.findOne({
            where: { email },
          });

          done(undefined, {
            token: result,
            user: {
              id: user?.id,
              email: user?.email,
              fullName: user?.fullName,
              picture,
            },
          });
        } catch (error) {
          console.error('Google OAuth error:', error);
          done(error as any, undefined);
        }
      },
    ),
  );
}

/**
 * Configura estrategia Microsoft para popup flow
 */
function configureMicrosoftStrategy() {
  if (
    !process.env.AUTH_SOCIAL_MICROSOFT_CLIENT_ID ||
    !process.env.AUTH_SOCIAL_MICROSOFT_CLIENT_SECRET
  ) {
    console.warn(
      'Microsoft OAuth no configurado. Falta AUTH_SOCIAL_MICROSOFT_CLIENT_ID o AUTH_SOCIAL_MICROSOFT_CLIENT_SECRET',
    );
    return;
  }

  const microsoftCallbackUrl =
    process.env.AUTH_SOCIAL_MICROSOFT_CALLBACK_URL ||
    `${process.env.BACKEND_URL}/auth/oauth/microsoft/callback`;

  passport.use(
    'microsoft-oauth-popup',
    new MicrosoftStrategy(
      {
        clientID: process.env.AUTH_SOCIAL_MICROSOFT_CLIENT_ID,
        clientSecret: process.env.AUTH_SOCIAL_MICROSOFT_CLIENT_SECRET,
        callbackURL: microsoftCallbackUrl,
        tenant: 'common',
      },
      async (accessToken, refreshToken, profile, done) => {
        try {
          const email = profile.emails?.[0]?.value;
          const displayName = profile.displayName || '';
          const picture = profile.photos?.[0]?.value || '';

          if (!email) {
            return done(new Error('No email found in Microsoft profile'), null);
          }

          const { firstName, lastName } = splitFullName(displayName);

          const database = await databaseInit();

          // Autentica o crea usuario
          const result = await AuthService.signinFromSocial(
            'microsoft',
            profile.id,
            email,
            true, // Microsoft siempre verifica email
            firstName,
            lastName,
            { database },
          );

          // Obtiene datos del usuario para enviar al frontend
          const user = await database.user.findOne({
            where: { email },
          });

          done(null, {
            token: result,
            user: {
              id: user?.id,
              email: user?.email,
              fullName: user?.fullName,
              picture,
            },
          });
        } catch (error) {
          console.error('Microsoft OAuth error:', error);
          done(error, null);
        }
      },
    ),
  );
}

/**
 * Maneja el callback de OAuth y retorna HTML con postMessage
 */
function handleOAuthCallback(res, err, authData) {
  if (err) {
    console.error('OAuth callback error:', err);
    const errorMessage = encodeURIComponent(
      err.message || 'Error en autenticación',
    );

    // HTML que envía el error al frontend via postMessage
    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <title>Autenticación</title>
        <script>
          window.opener.postMessage({
            type: 'oauth_callback',
            error: '${errorMessage}'
          }, window.opener.location.origin);
          window.close();
        </script>
      </head>
      <body>
        Cerrando ventana...
      </body>
      </html>
    `;

    return res.send(html);
  }

  if (!authData || !authData.token) {
    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <title>Autenticación</title>
        <script>
          window.opener.postMessage({
            type: 'oauth_callback',
            error: 'No se generó token de autenticación'
          }, window.opener.location.origin);
          window.close();
        </script>
      </head>
      <body>
        Cerrando ventana...
      </body>
      </html>
    `;

    return res.send(html);
  }

  // HTML que envía el token y usuario al frontend via postMessage
  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <title>Autenticación Exitosa</title>
      <script>
        const authData = ${JSON.stringify(authData)};
        window.opener.postMessage({
          type: 'oauth_callback',
          token: authData.token,
          user: authData.user
        }, window.opener.location.origin);
        window.close();
      </script>
    </head>
    <body>
      Autenticación exitosa. Cerrando ventana...
    </body>
    </html>
  `;

  res.send(html);
}

/**
 * Divide nombre completo en nombre y apellido
 */
function splitFullName(fullName: string) {
  let firstName = '';
  let lastName = '';

  if (fullName && fullName.trim()) {
    const parts = fullName.trim().split(' ');
    if (parts.length > 1) {
      firstName = parts[0];
      lastName = parts.slice(1).join(' ');
    } else {
      firstName = fullName.trim();
    }
  }

  return { firstName, lastName };
}
