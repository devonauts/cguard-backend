import 'express';

// Global augmentation for the request-scoped properties this codebase attaches
// to `express.Request` in middleware. Each field below is VERIFIED to be
// assigned somewhere in src/ (see middlewares/*, authMiddleware.ts, etc.).
declare global {
  namespace Express {
    interface Request {
      // Assigned in authMiddleware.ts via `AuthService.findByToken`. Left as
      // `any` on purpose: the current-user shape is a Sequelize model with
      // dynamically-attached `tenants`/role relations — fully typing it would
      // create circular deps with the models layer.
      currentUser?: any;

      // Assigned in tenantMiddleware.ts / tenantHeaderMiddleware.ts and several
      // api/* handlers (sometimes as a lean `{ id }` stub). Sequelize tenant model.
      currentTenant?: { id: string; name?: string; [k: string]: any } | null;

      // Assigned in databaseMiddleware.ts — the Sequelize models registry.
      // Dynamic; left as `any`.
      database?: any;

      // Assigned in languageMiddleware.ts (e.g. 'es' | 'pt-BR' | 'en').
      language?: string;

      // Assigned in authMiddleware.ts from decoded JWT session claims.
      authTokenClaims?: { sid?: string; ch?: string };
    }
  }
}

export {};
