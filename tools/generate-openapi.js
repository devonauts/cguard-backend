#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const apiDir = path.join(repoRoot, 'src', 'api');
const outDir = path.join(apiDir, 'documentation');
const outFile = path.join(outDir, 'openapi.json');

function walk(dir) {
  const results = [];
  const list = fs.readdirSync(dir);
  list.forEach((file) => {
    const p = path.join(dir, file);
    const stat = fs.statSync(p);
    if (stat && stat.isDirectory()) {
      if (file === 'documentation' || file === 'dist') return;
      results.push(...walk(p));
    } else {
      if (file.endsWith('.ts') || file.endsWith('.js')) {
        results.push(p);
      }
    }
  });
  return results;
}

function extractRoutesFromFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const routes = [];
  // Capture: app.get('/path', require('./handler').default, ...)
  const regex = /app\.(get|post|put|patch|delete)\s*\(\s*([`'\"])([^`'\"]+)\2\s*,\s*(?:require\(\s*([`'\"])([^`'\"]+)\4\s*\)\.(?:default)|([A-Za-z0-9_\.\'\"\/]+))/g;
  let m;
  while ((m = regex.exec(content)) !== null) {
    const method = m[1].toLowerCase();
    const rawPath = m[3];
    const requirePath = m[5] || null;
    routes.push({ method, rawPath, file: filePath, handlerRequire: requirePath });
  }
  return routes;
}

function pathToOpenApiPath(rawPath) {
  // replace :param with {param}
  return rawPath.replace(/:([a-zA-Z0-9_]+)/g, '{$1}');
}

function extractPathParams(rawPath) {
  const params = [];
  const re = /:([a-zA-Z0-9_]+)/g;
  let m;
  while ((m = re.exec(rawPath)) !== null) {
    params.push(m[1]);
  }
  return params;
}

function tagFromFile(filePath) {
  // derive tag from the api subfolder name if possible
  const parts = filePath.split(path.sep);
  const idx = parts.lastIndexOf('api');
  if (idx >= 0 && parts.length > idx + 1) {
    return parts[idx + 1];
  }
  return 'api';
}

function resolveHandlerFile(routeFile, requirePath) {
  if (!requirePath) return null;
  // requirePath may be './userCreate' or '../../some/path'
  const dir = path.dirname(routeFile);
  let resolved = path.resolve(dir, requirePath);
  // Try with .ts and .js
  const candidates = [resolved + '.ts', resolved + '.js', path.join(resolved, 'index.ts'), path.join(resolved, 'index.js')];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  // if the path already points to a file
  if (fs.existsSync(resolved)) return resolved;
  return null;
}

function extractOpenApiFromHandler(handlerFile) {
  if (!handlerFile) return null;
  const content = fs.readFileSync(handlerFile, 'utf8');
  // Find JSDoc blocks containing @openapi
  const jsdocRegex = /\/\*\*([\s\S]*?)\*\//g;
  let m;
  while ((m = jsdocRegex.exec(content)) !== null) {
    const block = m[1];
    if (block.indexOf('@openapi') !== -1) {
      // Extract JSON after @openapi
      const idx = block.indexOf('@openapi');
      const after = block.slice(idx + '@openapi'.length).trim();
      // Try to find JSON object inside braces
      const jsonStart = after.indexOf('{');
      const jsonEnd = after.lastIndexOf('}');
      if (jsonStart >= 0 && jsonEnd > jsonStart) {
        const jsonText = after.slice(jsonStart, jsonEnd + 1);
        try {
          return JSON.parse(jsonText);
        } catch (e) {
          // ignore parse errors
        }
      }
      // fallback: use the rest of the block as description
      return { description: after.replace(/\*+\s?/g, '\n').trim() };
    }
  }
  return null;
}

function buildSpec(routes) {
  const spec = {
    openapi: '3.0.0',
    info: {
      title: 'CGuard API',
      version: '1.0.0',
      description: 'Auto-generated OpenAPI spec (minimal) — run tools/generate-openapi.js to regenerate with more details.',
    },
    servers: [{ url: process.env.API_BASE_URL || 'http://localhost:8080' }],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT'
        }
      }
    },
    security: [{ bearerAuth: [] }],
    paths: {},
  };

  routes.forEach((r) => {
    const oaPath = pathToOpenApiPath(r.rawPath);
    if (!spec.paths[oaPath]) spec.paths[oaPath] = {};

    const params = extractPathParams(r.rawPath).map((p) => ({
      name: p,
      in: 'path',
      required: true,
      schema: { type: 'string' },
    }));

    const tag = tagFromFile(r.file);

    // try to resolve handler and extract @openapi JSDoc
    const handlerFile = resolveHandlerFile(r.file, r.handlerRequire);
    const handlerOpenApi = extractOpenApiFromHandler(handlerFile);

    const operation = {
      tags: [tag],
      summary: handlerOpenApi && handlerOpenApi.summary ? handlerOpenApi.summary : `${r.method.toUpperCase()} ${r.rawPath}`,
      description: handlerOpenApi && handlerOpenApi.description ? handlerOpenApi.description : undefined,
      parameters: params,
      responses: (handlerOpenApi && handlerOpenApi.responses) || {
        '200': { description: 'OK' },
        '400': { description: 'Bad Request' },
        '401': { description: 'Unauthorized' },
        '403': { description: 'Forbidden' },
        '404': { description: 'Not Found' },
      },
    };

    // if method may have a body, add a generic requestBody or use handler-provided
    if (['post', 'put', 'patch'].includes(r.method)) {
      if (handlerOpenApi && handlerOpenApi.requestBody) {
        operation.requestBody = handlerOpenApi.requestBody;
      } else {
        operation.requestBody = {
          content: {
            'application/json': {
              schema: { type: 'object' },
            },
          },
        };
      }
    }

    spec.paths[oaPath][r.method] = operation;
  });

  return spec;
}

function main() {
  console.log('Scanning API files under', apiDir);
  const files = walk(apiDir);
  const routes = [];
  files.forEach((f) => {
    const rs = extractRoutesFromFile(f);
    rs.forEach((r) => routes.push(r));
  });

  const spec = buildSpec(routes);

  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(spec, null, 2), 'utf8');
  console.log('Written', outFile, 'with', Object.keys(spec.paths).length, 'paths');
}

main();
