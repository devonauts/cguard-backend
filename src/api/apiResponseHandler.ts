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
      // Return structured JSON so frontends can display localized messages reliably.
      const payload = {
        message,
        code: error.code,
        messageCode: error.messageCode || null,
      };
      res.status(error.code).json(payload);
    } else {
      console.error(error);
      res.status(500).json({ message, code: 500 });
    }
  }
}
