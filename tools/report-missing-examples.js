const fs = require('fs');
const path = require('path');

const docPath = path.join(__dirname, '..', 'src', 'api', 'documentation', 'openapi.json');
const outPath = path.join(__dirname, '..', 'tmp', 'missing-examples.json');

if (!fs.existsSync(docPath)) {
  console.error('OpenAPI file not found:', docPath);
  process.exit(1);
}

const spec = JSON.parse(fs.readFileSync(docPath, 'utf8'));
const missing = [];

Object.keys(spec.paths || {}).forEach((p) => {
  const methods = spec.paths[p];
  Object.keys(methods).forEach((m) => {
    const op = methods[m];
    if (op.requestBody && op.requestBody.content && op.requestBody.content['application/json']) {
      const jsonPart = op.requestBody.content['application/json'];
      const ex = jsonPart.example;
      const isEmptyObject = ex && typeof ex === 'object' && Object.keys(ex).length === 0;
      if (!ex || isEmptyObject) {
        missing.push({ path: p, method: m.toUpperCase(), summary: op.summary || '', tag: (op.tags||[])[0] || '' });
      }
    }
  });
});

if (!fs.existsSync(path.join(__dirname, '..', 'tmp'))) fs.mkdirSync(path.join(__dirname, '..', 'tmp'));
fs.writeFileSync(outPath, JSON.stringify(missing, null, 2), 'utf8');
console.log('Wrote report to', outPath, 'entries:', missing.length);
