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
  const regex = /app\.(get|post|put|patch|delete)\s*\(/g;
  let m;
  while ((m = regex.exec(content)) !== null) {
    const method = m[0].split('.')[1].replace('(', '').trim();
    // find the start of the path string after the opening paren
    const afterOpen = content.slice(m.index + m[0].length);
    // path is the first quoted string in afterOpen
    const pathMatch = /([`'\"])([^`'\"]+)\1/.exec(afterOpen);
    if (!pathMatch) continue;
    const rawPath = pathMatch[2];
    // find the end of the app.*(...) call by locating the next occurrence of ');' after m.index
    const endIdx = content.indexOf(');', m.index);
    const argsBlock = endIdx > -1 ? content.slice(m.index + m[0].length, endIdx) : '';
    // try to find require(...) inside argsBlock
    const reqMatch = /require\(\s*([`'\"])([^`'\"]+)\1\s*\)\.(?:default)/.exec(argsBlock) || /require\(\s*([`'\"])([^`'\"]+)\1\s*\)/.exec(argsBlock);
    const requirePath = reqMatch ? reqMatch[2] : null;
    routes.push({ method: method.replace(/\(|\s/g,'').toLowerCase(), rawPath, file: filePath, handlerRequire: requirePath });
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

    function inferSchemaFromHandlerFile(filePath) {
      if (!filePath) return null;
      try {
        const props = new Set();

        function scanText(txt) {
          if (!txt) return;
          // req.body.prop
          const re1 = /req\.body\.([a-zA-Z0-9_]+)/g;
          let mm;
          while ((mm = re1.exec(txt)) !== null) props.add(mm[1]);

          // req.body['prop'] or req.body["prop"]
          const re2 = /req\.body\[['\"]([^'\"]+)['\"]\]/g;
          while ((mm = re2.exec(txt)) !== null) props.add(mm[1]);

          // destructuring: const { a, b } = req.body
          const re3 = /const\s*\{([^}]+)\}\s*=\s*req\.body/g;
          while ((mm = re3.exec(txt)) !== null) {
            const list = mm[1].split(',');
            list.forEach((i) => {
              const name = i.replace(/[:=].*$/,'').trim();
              if (name) props.add(name);
            });
          }

          // express-validator style: body('prop') or check('prop')
          const re4 = /(?:\bbody|\bcheck)\(['\"]([^'\"]+)['\"]\)/g;
          while ((mm = re4.exec(txt)) !== null) props.add(mm[1]);

          // var assignment: const b = req.body; then b.prop occurrences
          const reVar = /(?:const|let|var)\s+([a-zA-Z0-9_]+)\s*=\s*req\.body/g;
          const varNames = [];
          let mmVar;
          while ((mmVar = reVar.exec(txt)) !== null) varNames.push(mmVar[1]);
          if (varNames.length) {
            varNames.forEach((vn) => {
              const reProp = new RegExp(vn + "\\.([a-zA-Z0-9_]+)", 'g');
              let mm2;
              while ((mm2 = reProp.exec(txt)) !== null) props.add(mm2[1]);
            });
          }
        }

        // Scan the handler file
        const txt = fs.readFileSync(filePath, 'utf8');
        scanText(txt);

        // Also scan sibling files in the same directory to catch validators or shared code
        try {
          const dir = path.dirname(filePath);
          const files = fs.readdirSync(dir);
          files.forEach((f) => {
            const p = path.join(dir, f);
            try {
              const stat = fs.statSync(p);
              if (stat.isFile() && (p.endsWith('.js') || p.endsWith('.ts'))) {
                const t = fs.readFileSync(p, 'utf8');
                scanText(t);
              }
            } catch (e) { /* ignore */ }
          });
        } catch (e) {
          // ignore
        }

        if (props.size === 0) return null;
        const out = {};
        props.forEach((p) => { out[p] = { type: 'string' }; });
        return out;
      } catch (e) {
        return null;
      }
    }

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

    // Apply bearerAuth security to operations by default, except for auth endpoints
    // If the handler explicitly defines `security`, preserve it.
    const isAuthPath = oaPath.startsWith('/auth') || oaPath.indexOf('/auth/') === 0;
    if (handlerOpenApi && handlerOpenApi.security) {
      operation.security = handlerOpenApi.security;
    } else if (!isAuthPath) {
      operation.security = [{ bearerAuth: [] }];
    }

    // Add Authorization header parameter for non-auth endpoints so it appears in UI
    if (!isAuthPath) {
      const hasAuthHeader = (operation.parameters || []).some(p => p && p.in === 'header' && p.name && p.name.toLowerCase() === 'authorization');
      if (!hasAuthHeader) {
        operation.parameters = operation.parameters || [];
        operation.parameters.push({
          name: 'Authorization',
          in: 'header',
          required: false,
          description: 'Bearer token. Example: "Bearer <token>"',
          schema: { type: 'string' }
        });
      }
    }

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

      // Ensure there's an example for the request body so Swagger UI shows it
      try {
        const content = operation.requestBody && operation.requestBody.content;
        if (content && content['application/json']) {
          const jsonPart = content['application/json'];

          // If handler provided an explicit example, prefer it
          if (jsonPart.example) {
            // keep existing
          } else if (jsonPart.examples) {
            // pick the first example value if present
            const keys = Object.keys(jsonPart.examples || {});
            if (keys.length > 0 && jsonPart.examples[keys[0]] && jsonPart.examples[keys[0]].value) {
              jsonPart.example = jsonPart.examples[keys[0]].value;
            }
          } else if (jsonPart.schema) {
            // generate a small example from the schema properties
            // If schema has no properties, try to infer from handler code
            if (jsonPart.schema.type === 'object' && (!jsonPart.schema.properties || Object.keys(jsonPart.schema.properties).length === 0)) {
              const inferred = inferSchemaFromHandlerFile(handlerFile);
              if (inferred) jsonPart.schema.properties = inferred;
            }

            function genExampleFromSchema(sch) {
              if (!sch) return {};
              if (sch.example) return sch.example;
              if (sch.type === 'object' && sch.properties) {
                const out = {};
                Object.keys(sch.properties).forEach((k) => {
                  const prop = sch.properties[k];
                  if (prop.example !== undefined) {
                    out[k] = prop.example;
                  } else if (prop.type === 'string') {
                    out[k] = prop.format === 'date-time' ? new Date().toISOString() : 'string';
                  } else if (prop.type === 'integer' || prop.type === 'number') {
                    out[k] = 0;
                  } else if (prop.type === 'boolean') {
                    out[k] = false;
                  } else if (prop.type === 'array' && prop.items) {
                    out[k] = [genExampleFromSchema(prop.items)];
                  } else if (prop.type === 'object') {
                    out[k] = genExampleFromSchema(prop);
                  } else {
                    out[k] = null;
                  }
                });
                return out;
              }
              if (sch.type === 'array' && sch.items) return [genExampleFromSchema(sch.items)];
              if (sch.type === 'string') return 'string';
              if (sch.type === 'integer' || sch.type === 'number') return 0;
              if (sch.type === 'boolean') return false;
              return {};
            }

            jsonPart.example = genExampleFromSchema(jsonPart.schema);
            // If we generated an empty object, replace with a small non-empty placeholder
            try {
              const isEmptyObj = jsonPart.example && typeof jsonPart.example === 'object' && Object.keys(jsonPart.example).length === 0;
              if (isEmptyObj) {
                jsonPart.example = { _example: `Provide request body for ${r.method.toUpperCase()} ${oaPath}` };
              }
            } catch (e) {
              // ignore
            }
          } else {
            // fallback to empty object
            jsonPart.example = {};
          }
        }
      } catch (e) {
        // ignore example generation errors
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
