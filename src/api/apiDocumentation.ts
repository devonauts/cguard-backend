const express = require('express');
const fs = require('fs');
const path = require('path');

export default function setupSwaggerUI(app) {
  if (String(process.env.API_DOCUMENTATION_ENABLED) !== "true") {
    return;
  }

  const serveSwaggerDef = function serveSwaggerDef(
    req,
    res,
  ) {
    res.sendFile(
      path.resolve(
        __dirname + '/../documentation/openapi.json',
      ),
    );
  };
  app.get('/documentation-config', serveSwaggerDef);

  const swaggerUiAssetPath = require('swagger-ui-dist').getAbsoluteFSPath();
  const swaggerFiles = express.static(swaggerUiAssetPath);

  const urlRegex = /url: "[^"]*",/;

  const patchIndex = function patchIndex(req, res) {
    const indexContent = fs
      .readFileSync(`${swaggerUiAssetPath}/index.html`)
      .toString()
      .replace(urlRegex, 'url: "../documentation-config",');
    res.send(indexContent);
  };

  const patchInitializer = function patchInitializer(req, res) {
    try {
      const initContent = fs.readFileSync(`${swaggerUiAssetPath}/swagger-initializer.js`).toString();
      const patched = initContent.replace(/url:\s*"[^"]*"\s*,/, 'url: "/documentation-config",');
      res.setHeader('Content-Type', 'application/javascript');
      res.send(patched);
    } catch (err) {
      // fallback to sending original file
      res.sendFile(`${swaggerUiAssetPath}/swagger-initializer.js`);
    }
  };

  app.get(
    '/documentation',
    function getSwaggerRoot(req, res) {
      let targetUrl = req.originalUrl;
      if (!targetUrl.endsWith('/')) {
        targetUrl += '/';
      }
      targetUrl += 'index.html';
      res.redirect(targetUrl);
    },
  );
  app.get('/documentation/index.html', patchIndex);
  app.get('/documentation/swagger-initializer.js', patchInitializer);

  app.use('/documentation', swaggerFiles);
}
