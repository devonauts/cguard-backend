#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { fieldExamples, routeExamples, listResponseExamples, specialResponses } = require('./openapi-examples');

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

function resolveTemplateVariables(content, rawPath) {
  // If the path contains ${...} template expressions, try to resolve them
  // by finding the variable assignment in the file (e.g. const base = '/tenant/:tenantId/attendance')
  const templateVarRegex = /\$\{(\w+)\}/g;
  let resolved = rawPath;
  let tm;
  while ((tm = templateVarRegex.exec(rawPath)) !== null) {
    const varName = tm[1];
    // Look for: const varName = '...' or let varName = '...' or var varName = '...'
    const varDefRegex = new RegExp(`(?:const|let|var)\\s+${varName}\\s*=\\s*(['"\`])([^'"\`]+)\\1`);
    const varMatch = varDefRegex.exec(content);
    if (varMatch) {
      resolved = resolved.replace(tm[0], varMatch[2]);
    }
  }
  return resolved;
}

function extractRoutesFromFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const routes = [];
  // Match any variable calling .get/.post/.put/.patch/.delete (app, routes, router, etc.)
  const regex = /\b(\w+)\.(get|post|put|patch|delete)\s*\(/g;
  let m;
  while ((m = regex.exec(content)) !== null) {
    const varName = m[1];
    const method = m[2];
    // Skip non-router calls (e.g. Promise.resolve, Object.keys, Array.filter etc.)
    const skipVars = ['Promise', 'Object', 'Array', 'Math', 'JSON', 'console', 'process', 'fs', 'path', 'Date', 'String', 'Number', 'res', 'db', 'sequelize', 'model', 'Model', 'https', 'http', 'axios', 'fetch', 'req'];
    if (skipVars.includes(varName)) continue;
    // find the start of the path string after the opening paren
    const afterOpen = content.slice(m.index + m[0].length);
    // path is the first quoted string (or template literal) in afterOpen
    const pathMatch = /([`'"])([^`'"]+)\1/.exec(afterOpen);
    let rawPath = null;
    if (pathMatch) {
      rawPath = pathMatch[2];
      // If it was a backtick template with ${...}, resolve variables
      if (pathMatch[1] === '`' && rawPath.includes('${')) {
        rawPath = resolveTemplateVariables(content, rawPath);
      }
    }
    if (!rawPath) continue;
    // Skip paths that don't look like URL routes
    if (!rawPath.startsWith('/')) continue;
    // Skip paths that contain spaces or newlines (false positives from comments/strings)
    if (/[\s\n]/.test(rawPath)) continue;
    // find the end of the call by locating the next occurrence of ');' after m.index
    const endIdx = content.indexOf(');', m.index);
    const argsBlock = endIdx > -1 ? content.slice(m.index + m[0].length, endIdx) : '';
    // try to find require(...) inside argsBlock
    const reqMatch = /require\(\s*([`'"])([^`'"]+)\1\s*\)\.(?:default)/.exec(argsBlock) || /require\(\s*([`'"])([^`'"]+)\1\s*\)/.exec(argsBlock);
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
    servers: [{ url: process.env.API_BASE_URL || 'https://api.cguardpro.com/api' }],
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
      tags: (handlerOpenApi && handlerOpenApi.tags) ? handlerOpenApi.tags : [tag],
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

    // ── Apply route-specific or special response examples ──────────────────
    const routeKey = `${r.method.toUpperCase()} ${oaPath}`;

    // Add response example for GET operations
    if (r.method === 'get') {
      const specialResp = specialResponses[routeKey];
      const listResp = listResponseExamples[oaPath];
      const responseExample = specialResp || listResp;
      if (responseExample) {
        operation.responses['200'] = {
          description: 'OK',
          content: {
            'application/json': {
              example: responseExample,
            },
          },
        };
      }
    }

    // Add response example for POST/PUT/PATCH from routeExamples
    if (routeExamples[routeKey] && routeExamples[routeKey].response) {
      operation.responses['200'] = {
        description: 'OK',
        content: {
          'application/json': {
            example: routeExamples[routeKey].response,
          },
        },
      };
    }

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

          // 1. Check for route-specific example from our examples file
          const routeExample = routeExamples[routeKey];
          if (routeExample && routeExample.request) {
            jsonPart.example = routeExample.request;
          } else if (jsonPart.example) {
            // keep existing handler-provided example
          } else if (jsonPart.examples) {
            const keys = Object.keys(jsonPart.examples || {});
            if (keys.length > 0 && jsonPart.examples[keys[0]] && jsonPart.examples[keys[0]].value) {
              jsonPart.example = jsonPart.examples[keys[0]].value;
            }
          } else if (jsonPart.schema) {
            // generate from schema with domain-aware values
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
                  } else if (fieldExamples[k] !== undefined) {
                    // Use domain-aware example value
                    out[k] = fieldExamples[k];
                  } else if (prop.type === 'string') {
                    if (prop.format === 'date-time') out[k] = '2026-06-07T08:00:00.000Z';
                    else if (prop.format === 'date') out[k] = '2026-06-07';
                    else if (prop.format === 'email') out[k] = 'usuario@empresa.com';
                    else if (prop.format === 'uri' || prop.format === 'url') out[k] = 'https://www.empresa.com';
                    else if (k.toLowerCase().includes('id')) out[k] = '550e8400-e29b-41d4-a716-446655440000';
                    else if (k.toLowerCase().includes('email')) out[k] = 'usuario@empresa.com';
                    else if (k.toLowerCase().includes('phone')) out[k] = '+593987654321';
                    else if (k.toLowerCase().includes('date')) out[k] = '2026-06-07';
                    else if (k.toLowerCase().includes('time')) out[k] = '2026-06-07T08:00:00.000Z';
                    else if (k.toLowerCase().includes('name')) out[k] = 'Nombre ejemplo';
                    else if (k.toLowerCase().includes('address')) out[k] = 'Av. 6 de Diciembre N33-44';
                    else if (k.toLowerCase().includes('description')) out[k] = 'Descripción del recurso.';
                    else out[k] = 'string';
                  } else if (prop.type === 'integer' || prop.type === 'number') {
                    if (k.toLowerCase().includes('lat')) out[k] = -0.180653;
                    else if (k.toLowerCase().includes('lon') || k.toLowerCase().includes('lng')) out[k] = -78.467834;
                    else if (k.toLowerCase().includes('rate')) out[k] = 12.50;
                    else if (k.toLowerCase().includes('total') || k.toLowerCase().includes('amount')) out[k] = 2500.00;
                    else if (k.toLowerCase().includes('quantity') || k.toLowerCase().includes('count')) out[k] = 10;
                    else out[k] = 0;
                  } else if (prop.type === 'boolean') {
                    out[k] = true;
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
            // If we generated an empty object, use a helpful placeholder
            try {
              const isEmptyObj = jsonPart.example && typeof jsonPart.example === 'object' && Object.keys(jsonPart.example).length === 0;
              if (isEmptyObj) {
                jsonPart.example = { data: { _note: `Provide request body for ${r.method.toUpperCase()} ${oaPath}` } };
              }
            } catch (e) {
              // ignore
            }
          } else {
            // fallback: try to match from route examples by partial path
            jsonPart.example = { data: {} };
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

  // Resolve prefix for sub-router modules (e.g. superadmin/*.ts routes are
  // mounted under /superadmin via app.use('/superadmin', router))
  const prefixMap = {};
  // Scan index files that mount sub-routers with app.use('/prefix', router)
  files.forEach((f) => {
    if (!f.endsWith('index.ts') && !f.endsWith('index.js')) return;
    const content = fs.readFileSync(f, 'utf8');
    // Match: app.use('/superadmin', router) or similar
    const useRegex = /\b\w+\.use\(\s*['"`]([^'"`]+)['"`]\s*,\s*(\w+)\s*\)/g;
    let um;
    while ((um = useRegex.exec(content)) !== null) {
      const prefix = um[1];
      // Skip if it looks like a middleware path (e.g. '/api') rather than a sub-router mount
      if (prefix === '/api') continue;
      // Check if this file also has require statements for sub-modules that get the router
      const dir = path.dirname(f);
      const reqRegex = /require\(\s*['"`]\.\/([^'"`]+)['"`]\s*\)/g;
      let rm;
      while ((rm = reqRegex.exec(content)) !== null) {
        const subMod = rm[1].replace(/['"`]/g, '');
        const subPath = path.resolve(dir, subMod);
        // Map both the resolved file and the directory
        const candidates = [subPath, subPath + '.ts', subPath + '.js', path.join(subPath, 'index.ts'), path.join(subPath, 'index.js')];
        for (const c of candidates) {
          if (fs.existsSync(c)) {
            prefixMap[c] = prefix;
            break;
          }
        }
      }
      // Also map the directory itself (all files inside get the prefix)
      prefixMap[dir + '/'] = prefix;
    }
  });

  // Remove the index file's own directory from prefixMap to avoid double-prefixing
  // Only sub-module files (not the index itself) should get the prefix
  
  // Apply prefixes to routes from sub-router files
  routes.forEach((r) => {
    for (const [filePath, prefix] of Object.entries(prefixMap)) {
      // Check if this route's file matches a prefixed sub-module
      if (filePath.endsWith('/')) {
        // Directory prefix: apply to all files in that directory EXCEPT the index itself
        if (r.file.startsWith(filePath) && !r.file.endsWith('index.ts') && !r.file.endsWith('index.js') && !r.rawPath.startsWith(prefix)) {
          r.rawPath = prefix + r.rawPath;
          break;
        }
      } else if (r.file === filePath && !r.rawPath.startsWith(prefix)) {
        r.rawPath = prefix + r.rawPath;
        break;
      }
    }
  });

  // Normalize paths: strip /api/ prefix from paths that were registered directly
  // on the app (e.g. /api/places/autocomplete) since the server URL already includes /api
  routes.forEach((r) => {
    if (r.rawPath.startsWith('/api/')) {
      r.rawPath = r.rawPath.slice(4); // remove '/api' prefix, keep the rest
    }
  });

  const spec = buildSpec(routes);

  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(spec, null, 2), 'utf8');
  console.log('Written', outFile, 'with', Object.keys(spec.paths).length, 'paths');
}

main();
