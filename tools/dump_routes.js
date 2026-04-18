const fs = require('fs');
const path = require('path');
const file = path.join(__dirname, '..', 'src', 'api', 'auth', 'index.ts');
const content = fs.readFileSync(file,'utf8');
const regex = /app\.(get|post|put|patch|delete)\s*\(\s*([`'\"])([^`'\"]+)\2\s*,([\s\S]*?)\)/g;
let m;
while ((m = regex.exec(content)) !== null) {
  const method = m[1].toLowerCase();
  const rawPath = m[3];
  const after = m[4] || '';
  console.log('--- AFTER START ---');
  console.log(after);
  console.log('--- AFTER END ---');
  const reqMatch = /require\(\s*([`'\"])([^`'\"]+)\1\s*\)\.(?:default)/.exec(after) || /require\(\s*([`'\"])([^`'\"]+)\1\s*\)/.exec(after);
  const requirePath = reqMatch ? reqMatch[2] : null;
  console.log(method.toUpperCase(), rawPath, '->', requirePath);
}
