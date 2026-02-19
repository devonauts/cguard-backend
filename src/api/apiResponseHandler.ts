import { i18n } from '../i18n';

export default class ApiResponseHandler {
  static async download(req, res, path) {
    // Set additional headers for file downloads to prevent CORS issues
    res.header('Cross-Origin-Resource-Policy', 'cross-origin');
    res.header('Cross-Origin-Embedder-Policy', 'unsafe-none');
    res.download(path);
  }

  static async success(req, res, payload) {
    if (payload !== undefined) {
      res.status(200).send(payload);
    } else {
      res.sendStatus(200);
    }
  }

  static async error(req, res, error) {
    const message = (error && error.message) ? error.message : 'Internal server error';

    // For simpler frontend consumption (toasts, alerts), return plain text instead of JSON object
    if (error && [400, 401, 403, 404].includes(error.code)) {
      // If a messageCode is present, attempt to resolve a localized message
      let localizedMessage = message;
      try {
        if (error.messageCode) {
          const resolved = i18n(req && req.language ? req.language : undefined, error.messageCode);
          // i18n returns the key when not found; only accept resolved if it actually differs
          if (resolved && resolved !== error.messageCode) {
            localizedMessage = resolved;
          }
        }
      } catch (e) {
        // ignore localization failure and keep default message
      }

      // Return structured JSON so frontends can display localized messages reliably.
      const payload: any = {
        message: localizedMessage,
        code: error.code,
        messageCode: error.messageCode || null,
      };

      // If the thrown error carried field-level validation errors, include them
      if (error && (error as any).errors) {
        payload.errors = (error as any).errors;
      }
      res.status(error.code).json(payload);
    } else {
      console.error(error);
      res.status(500).json({ message, code: 500 });
    }
  }
}
