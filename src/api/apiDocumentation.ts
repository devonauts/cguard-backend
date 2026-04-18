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
    // The generated spec is placed under src/api/documentation/openapi.json
    res.sendFile(path.resolve(__dirname + '/documentation/openapi.json'));
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
      let patched = initContent.replace(/url:\s*"[^"]*"\s*,/, 'url: "/documentation-config",');
      // Inject a small helper to allow pasting a Bearer token and preauthorize it in the UI.
      const injected = `\n// BEGIN injected by apiDocumentation
(function(){\n  function addBearerButton(){\n    try{\n      var btn = document.createElement('button');\n      btn.innerText = 'Set Bearer Token';\n      btn.style.position = 'fixed';\n      btn.style.right = '10px';\n      btn.style.top = '10px';\n      btn.style.zIndex = 2147483647;\n      btn.style.padding = '6px 10px';\n      btn.style.background = '#1976d2';\n      btn.style.color = '#fff';\n      btn.style.border = 'none';\n      btn.style.borderRadius = '4px';\n      btn.style.cursor = 'pointer';\n      btn.onclick = function(){\n        var t = prompt('Paste your JWT token (without the \"Bearer \" prefix):');\n        if(t && window.ui && typeof window.ui.preauthorizeApiKey === 'function'){\n          window.ui.preauthorizeApiKey('bearerAuth','Bearer '+t);\n          alert('Bearer token set');\n        }\n      };\n      document.body.appendChild(btn);\n      // If an env-injected token is present, preauthorize automatically
      if(window.SWAGGER_PREAUTH_TOKEN && window.ui && typeof window.ui.preauthorizeApiKey === 'function'){
        window.ui.preauthorizeApiKey('bearerAuth','Bearer '+window.SWAGGER_PREAUTH_TOKEN);
      }\n    }catch(e){ /* ignore */ }\n  }\n  if(document.readyState === 'complete') addBearerButton(); else window.addEventListener('load', addBearerButton);\n})();\n// END injected\n`;
      patched = patched + injected;
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
