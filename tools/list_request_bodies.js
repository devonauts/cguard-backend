const fs = require('fs');
const p = require('path');
const file = p.join(__dirname, '..', 'src', 'api', 'documentation', 'openapi.json');
const j = JSON.parse(fs.readFileSync(file, 'utf8'));
const results = [];
for (const pathKey of Object.keys(j.paths || {})) {
  const methods = j.paths[pathKey];
  for (const method of Object.keys(methods)) {
    const op = methods[method];
    if (op.requestBody && op.requestBody.content && op.requestBody.content['application/json'] && op.requestBody.content['application/json'].schema) {
      const schema = op.requestBody.content['application/json'].schema;
      const hasProps = schema.properties && Object.keys(schema.properties).length > 0;
      if (schema.type === 'object' && !hasProps) {
        results.push({ path: pathKey, method, tags: op.tags || [], summary: op.summary || '' });
      }
    }
  }
}
console.log(JSON.stringify(results, null, 2));
