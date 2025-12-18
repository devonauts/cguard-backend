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
    if (
      error &&
      [400, 401, 403, 404].includes(error.code)
    ) {
      res.status(error.code).json({ message: error.message });
    } else {
      console.error(error);
      res.status(500).json({ message: error.message || 'Internal server error' });
    }
  }
}
