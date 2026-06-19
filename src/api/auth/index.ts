import { createRateLimiter } from '../apiRateLimiter';

export default (app) => {
  app.put(
    `/auth/password-reset`,
    require('./authPasswordReset').default,
  );

  const emailRateLimiter = createRateLimiter({
    max: 6,
    windowMs: 15 * 60 * 1000,
    message: 'errors.429',
  });

  app.post(
    `/auth/send-email-address-verification-email`,
    emailRateLimiter,
    require('./authSendEmailAddressVerificationEmail')
      .default,
  );

  app.post(
    `/auth/send-password-reset-email`,
    emailRateLimiter,
    require('./authSendPasswordResetEmail').default,
  );

  // Keyed by IP, so a single office/demo IP shares one bucket across every
  // account + the worker app + retries — 20/15min was exhausted during demos.
  // 100/15min still stops real brute-force (the email/reset limiters stay
  // strict). Tunable via SIGNIN_RATE_MAX without a code change.
  const signInRateLimiter = createRateLimiter({
    max: Number(process.env.SIGNIN_RATE_MAX) || 100,
    windowMs: 15 * 60 * 1000,
    message: 'errors.429',
  });

  app.post(
    `/auth/sign-in`,
    signInRateLimiter,
    require('./authSignIn').default,
  );

  app.post(
    `/auth/sign-in-customer`,
    signInRateLimiter,
    require('./authSignInCustomer').default,
  );

  const signUpRateLimiter = createRateLimiter({
    max: 20,
    windowMs: 60 * 60 * 1000,
    message: 'errors.429',
  });

  app.post(
    `/auth/sign-up`,
    signUpRateLimiter,
    require('./authSignUp').default,
  );

  app.put(
    `/auth/profile`,
    require('./authUpdateProfile').default,
  );

  app.post(
    `/auth/change-email`,
    require('./authChangeEmail').default,
  );

  app.put(
    `/auth/change-password`,
    require('./authPasswordChange').default,
  );

  app.put(
    `/auth/verify-email`,
    require('./authVerifyEmail').default,
  );

  app.post(
    `/auth/send-phone-verification`,
    require('./authSendPhoneVerification').default,
  );

  app.post(
    `/auth/verify-phone`,
    require('./authVerifyPhone').default,
  );

  app.get(`/auth/me`, require('./authMe').default);

  app.post(`/auth/sign-out`, require('./authSignOut').default);

  // OAuth popup flow (Google y Microsoft)
  require('./authOAuth').default(app);
};
